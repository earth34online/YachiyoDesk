"""Headless PMX to VRM 1.0 conversion for YachiyoDesk.

Run inside the bundled Blender environment:
  blender --background --factory-startup --python pmx_to_vrm.py -- input.pmx output.vrm report.json
"""

from __future__ import annotations

import json
import sys
import traceback
from array import array
from pathlib import Path

import bpy
sys.path.insert(0, str(Path(__file__).resolve().parent))
from garment_dynamics import garment_kind, garment_spring_settings
from garment_collision import add_garment_collisions
from sleeve_rig import add_unrigged_sleeve_springs
from skin_binding import audit_and_repair_skin_bindings


REQUIRED_HUMAN_BONES = {
    "hips",
    "spine",
    "head",
    "leftUpperArm",
    "rightUpperArm",
    "leftLowerArm",
    "rightLowerArm",
    "leftHand",
    "rightHand",
    "leftUpperLeg",
    "rightUpperLeg",
    "leftLowerLeg",
    "rightLowerLeg",
    "leftFoot",
    "rightFoot",
}


def arguments() -> tuple[Path, Path, Path, bool]:
    if "--" not in sys.argv:
        raise RuntimeError("Missing converter arguments after --")
    values = sys.argv[sys.argv.index("--") + 1 :]
    compatibility_mode = len(values) == 4 and values[3] == "--compatibility-mode"
    if len(values) != 3 and not compatibility_mode:
        raise RuntimeError("Expected: input.pmx output.vrm report.json [--compatibility-mode]")
    return (Path(values[0]).resolve(), Path(values[1]).resolve(), Path(values[2]).resolve(), compatibility_mode)


def write_report(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.armatures,
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def enable_converter_addons() -> None:
    modules = ("bl_ext.blender_org.mmd_tools", "bl_ext.blender_org.vrm")
    for module in modules:
        if module not in bpy.context.preferences.addons:
            result = bpy.ops.preferences.addon_enable(module=module)
            if result != {"FINISHED"}:
                raise RuntimeError(f"Unable to enable Blender extension: {module}")


def enable_crash_compatibility_mode() -> None:
    """Retry-only workaround for Blender 4.5 native add-on crashes.

    Keep the ordinary high-fidelity path untouched. This fallback omits PMX
    custom normals (Blender recomputes them) and the add-on's Geometry Nodes
    outline preview, while retaining exported MToon outline metadata.
    """
    from bl_ext.blender_org.mmd_tools.core.pmx.importer import PMXImporter
    from bl_ext.blender_org.vrm.editor.mtoon1 import property_group

    PMXImporter._PMXImporter__assignCustomNormals = lambda self: None
    property_group.refresh_mtoon1_outline = lambda *args, **kwargs: None


def import_pmx(input_path: Path) -> None:
    from bl_ext.blender_org.mmd_tools.core import pmx

    # Some PMX archives contain a texture whose filename was damaged during
    # packaging/extraction, while the PMX still references its original name.
    # Repair the in-memory texture path only when the damaged filename is a
    # unique match. Never rename or overwrite the user's source files.
    model = pmx.load(str(input_path))
    used_indices = set()
    for material in model.materials:
        for index in (
            material.texture,
            material.sphere_texture,
            -1 if material.is_shared_toon_texture else material.toon_texture,
        ):
            if index >= 0:
                used_indices.add(index)
    recovered = []
    missing = []
    for index in sorted(used_indices):
        if index >= len(model.textures):
            missing.append({"index": index, "expected": "<invalid PMX texture index>"})
            continue
        texture = model.textures[index]
        expected = Path(texture.path)
        if expected.is_file():
            continue
        prefix_end = next((i for i, c in enumerate(expected.stem) if not c.isascii()), len(expected.stem))
        ascii_prefix = expected.stem[:prefix_end]
        candidates = []
        if len(ascii_prefix) >= 3 and expected.parent.is_dir():
            candidates = [
                candidate for candidate in expected.parent.iterdir()
                if candidate.is_file()
                and candidate.stat().st_size > 0
                and candidate.suffix.casefold() == expected.suffix.casefold()
                and candidate.stem.casefold().startswith(ascii_prefix.casefold())
                and "\ufffd" in candidate.name
            ]
        if len(candidates) == 1:
            texture.path = str(candidates[0])
            recovered.append({"index": index, "expected": str(expected), "resolved": texture.path})
        else:
            missing.append({"index": index, "expected": str(expected), "candidateCount": len(candidates)})
    import_pmx.texture_diagnostics = {"recoveredTextures": recovered, "missingTextures": missing}
    print("YACHIYO_PMX_TEXTURE_DIAGNOSTICS " + json.dumps(import_pmx.texture_diagnostics, ensure_ascii=False))
    if missing:
        names = ", ".join(Path(item["expected"]).name for item in missing[:5])
        raise RuntimeError(f"PMX 引用的贴图缺失或文件名不匹配：{names}。请将模型与 TEX 等贴图目录一起正确解压。")

    original_load = pmx.load
    try:
        pmx.load = lambda path: model if Path(path).resolve() == input_path else original_load(path)
        result = bpy.ops.mmd_tools.import_model(
            filepath=str(input_path),
            types={"MESH", "ARMATURE", "PHYSICS", "MORPHS"},
            scale=0.08,
            clean_model=False,
            remove_doubles=False,
            fix_bone_order=True,
            fix_ik_links=True,
            apply_bone_fixed_axis=False,
            rename_bones=False,
            use_underscore=False,
            use_mipmap=True,
            log_level="INFO",
            save_log=False,
        )
    finally:
        pmx.load = original_load
    if result != {"FINISHED"}:
        raise RuntimeError(f"MMD Tools import failed: {sorted(result)}")


def find_armature() -> bpy.types.Object:
    armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("PMX import produced no armature")
    return max(armatures, key=lambda obj: len(obj.data.bones))


def _weighted_vertex_groups(armature: bpy.types.Object) -> set[str]:
    """Return deform groups that actually influence imported PMX meshes.

    MMD models frequently keep a parallel ``D`` (deform) chain for legs and
    arms.  The visible mesh can be weighted entirely to that chain while the
    similarly named display/IK bones receive no vertices.  VRM's normalized
    humanoid pose only drives the assigned bone, so detecting this at import
    time is the portable way to preserve animation for every PMX model.
    """
    weighted: set[str] = set()
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if not any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in obj.modifiers):
            continue
        groups = obj.vertex_groups
        for vertex in obj.data.vertices:
            for assignment in vertex.groups:
                if assignment.weight <= 0.0001 or assignment.group >= len(groups):
                    continue
                weighted.add(groups[assignment.group].name)
    return weighted


def _compact_bone_name(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum() or "\u3400" <= character <= "\u9fff")


def _find_weighted_deform_alias(
    human_bone_name: str,
    source_name: str,
    armature: bpy.types.Object,
    weighted_groups: set[str],
) -> str | None:
    """Find a weighted helper/deform bone that mirrors an unweighted VRM bone.

    The exact suffixes cover common MMD Tools imports (``足D``, ``足首D`` and
    ``足先EX``).  The compact-name fallback also handles Latin/underscore
    variants used by PMX models from other authoring tools, while requiring an
    explicit deform-like suffix so an unrelated child is never selected.
    """
    bone_names = set(armature.data.bones.keys())
    exact: list[str] = []
    if human_bone_name.endswith("UpperLeg"):
        exact = [f"{source_name}D", f"{source_name}_D", f"{source_name}d", f"{source_name}捩", f"{source_name}twist"]
    elif human_bone_name.endswith("LowerLeg"):
        exact = [f"{source_name}D", f"{source_name}_D", f"{source_name}d", f"{source_name}捩", f"{source_name}twist"]
    elif human_bone_name.endswith("Foot"):
        exact = [f"{source_name}D", f"{source_name}_D", f"{source_name}d", f"{source_name}捩", f"{source_name}twist"]
    elif human_bone_name.endswith("Toes"):
        side = "左" if source_name.startswith("左") else "右" if source_name.startswith("右") else ""
        exact = [
            f"{source_name}D", f"{source_name}_D", f"{source_name}d",
            f"{side}足先EX" if side else "",
            f"{side}足先D" if side else "",
        ]
    for candidate in exact:
        if candidate and candidate in bone_names and candidate in weighted_groups:
            return candidate

    source_compact = _compact_bone_name(source_name)
    if len(source_compact) < 2:
        return None
    deform_markers = ("d", "deform", "twist", "捩", "先ex", "ikd")
    candidates: list[tuple[int, str]] = []
    for candidate in weighted_groups:
        if candidate not in bone_names or candidate == source_name:
            continue
        compact = _compact_bone_name(candidate)
        if not compact.startswith(source_compact):
            continue
        suffix = compact[len(source_compact):]
        if not suffix or not any(marker in suffix for marker in deform_markers):
            continue
        # Prefer the shortest explicit alias; it is normally the parallel
        # deform bone rather than a deeper toe/twist descendant.
        candidates.append((len(suffix), candidate))
    return min(candidates)[1] if candidates else None


def retarget_unweighted_humanoid_bones(
    armature: bpy.types.Object,
    human_bones: object,
    assigned: dict[str, str],
) -> list[dict[str, str]]:
    """Move leg/toe humanoid assignments onto weighted PMX deform aliases.

    This is deliberately generic and only activates when the automatic VRM
    bone has no weighted vertices.  Models that already weight their ordinary
    humanoid chain are left byte-for-byte unchanged in terms of mapping.
    """
    weighted_groups = _weighted_vertex_groups(armature)
    retargeted: list[dict[str, str]] = []
    extension = armature.data.vrm_addon_extension
    human_map = extension.vrm1.humanoid.human_bones.human_bone_name_to_human_bone()
    targets = ("leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot", "leftToes", "rightToes")
    for name in targets:
        human_bone = next((item for key, item in human_map.items() if getattr(key, "value", str(key)) == name), None)
        source_name = assigned.get(name)
        if human_bone is None or not source_name or source_name in weighted_groups:
            continue
        candidate = _find_weighted_deform_alias(name, source_name, armature, weighted_groups)
        if not candidate:
            continue
        human_bone.node.bone_name = candidate
        assigned[name] = candidate
        retargeted.append({"humanBone": name, "from": source_name, "to": candidate})
    return retargeted


def assign_humanoid(armature: bpy.types.Object) -> dict[str, str]:
    extension = armature.data.vrm_addon_extension
    extension.spec_version = "1.0"
    result = bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(
        armature_object_name=armature.name
    )
    if result != {"FINISHED"}:
        raise RuntimeError(f"VRM automatic bone assignment failed: {sorted(result)}")

    human_bones = extension.vrm1.humanoid.human_bones
    # Automatic MMD mapping often chooses the global "センター" controller as
    # VRM hips. That point sits below the anatomical pelvis and makes the legs
    # start above their parent. Prefer the standard MMD waist junction, whose
    # descendants branch into upper body, lower body and both legs.
    bone_names = set(armature.data.bones.keys())
    waist_name = next((name for name in ("腰", "waist", "Waist") if name in bone_names), None)
    if waist_name:
        for human_bone_name, human_bone in human_bones.human_bone_name_to_human_bone().items():
            name = getattr(human_bone_name, "value", str(human_bone_name))
            if name == "hips":
                human_bone.node.bone_name = waist_name
                break
    assigned: dict[str, str] = {}
    for human_bone_name, human_bone in human_bones.human_bone_name_to_human_bone().items():
        name = getattr(human_bone_name, "value", str(human_bone_name))
        if human_bone.node.bone_name:
            assigned[name] = human_bone.node.bone_name
    retarget_unweighted_humanoid_bones(armature, human_bones, assigned)
    return assigned


def configure_metadata(armature: bpy.types.Object, input_path: Path) -> None:
    meta = armature.data.vrm_addon_extension.vrm1.meta
    meta.vrm_name = input_path.stem[:80]
    meta.version = "1.0"
    if not meta.authors:
        meta.authors.add().value = "Local PMX conversion"
    meta.copyright_information = "Converted locally from the selected PMX source"
    meta.avatar_permission = "onlyAuthor"
    meta.commercial_usage = "personalNonProfit"
    meta.credit_notation = "required"
    meta.allow_redistribution = False
    meta.modification = "allowModification"


def configure_spring_bones(armature: bpy.types.Object) -> dict[str, object]:
    result = bpy.ops.vrm.assign_spring_bone1_from_mmd(armature_object_name=armature.name)
    spring_bone = armature.data.vrm_addon_extension.spring_bone1
    tuned: dict[str, int] = {}
    trimmed_circumferential_roots = 0
    for spring in spring_bone.springs:
        # The add-on translates MMD rigid-body relationships but leaves every
        # joint at 1 stiffness / 0 gravity. Apply dynamics only when the PMX
        # actually has a dedicated garment chain. Rigid, bone-less sleeves
        # cannot safely be made cloth by changing their arm skin weights.
        first_name = spring.joints[0].node.bone_name if spring.joints else ""
        kind = garment_kind(first_name or spring.vrm_name)
        if not kind or len(spring.joints) < 2:
            continue
        if kind == "skirt" and len(spring.joints) >= 8:
            # MMD physics can form a *horizontal waistband* and then continue
            # down one skirt rib in the same bone chain. VRM spring bones treat
            # that whole list as one hanging strand; simulating the waistband
            # rotates its followers and can collapse half a skirt. Only trim
            # when at least five consecutive links are clearly circumferential
            # and the next link clearly descends. Pure vertical skirt chains
            # (and all authored mesh skinning) remain unchanged.
            points = [armature.data.bones.get(joint.node.bone_name) for joint in spring.joints]
            if all(points):
                horizontal_links = 0
                for a, b in zip(points, points[1:]):
                    delta = b.head_local - a.head_local
                    xy = (delta.x * delta.x + delta.y * delta.y) ** 0.5
                    if xy >= 0.012 and abs(delta.z) <= 0.007:
                        horizontal_links += 1
                    else:
                        break
                if horizontal_links >= 5 and horizontal_links + 2 < len(points):
                    a, b = points[horizontal_links], points[horizontal_links + 1]
                    delta = b.head_local - a.head_local
                    xy = (delta.x * delta.x + delta.y * delta.y) ** 0.5
                    if delta.z <= -0.012 and xy <= abs(delta.z) * 0.65:
                        for _ in range(horizontal_links + 1):
                            spring.joints.remove(0)
                        trimmed_circumferential_roots += 1
        for index, joint in enumerate(spring.joints):
            values = garment_spring_settings(kind, index, len(spring.joints))
            joint.stiffness = values["stiffness"]
            joint.gravity_power = values["gravity_power"]
            joint.drag_force = values["drag_force"]
            if spring.collider_groups:
                joint.hit_radius = values["hit_radius"]
        tuned[kind] = tuned.get(kind, 0) + 1
    named_garment_materials = {
        kind
        for material in bpy.data.materials
        if (kind := garment_kind(material.name)) is not None
    }
    return {
        "result": ",".join(sorted(result)),
        "colliders": len(spring_bone.colliders),
        "colliderGroups": len(spring_bone.collider_groups),
        "springs": len(spring_bone.springs),
        "joints": sum(len(spring.joints) for spring in spring_bone.springs),
        "tunedGarmentChains": tuned,
        "trimmedCircumferentialRoots": trimmed_circumferential_roots,
        "garmentsWithoutNamedSpringChains": sorted(named_garment_materials - tuned.keys()),
    }


def image_alpha_mode(image: bpy.types.Image | None) -> str | None:
    """Return the glTF alpha mode required by a source RGBA texture.

    PMX commonly stores cut-out pixels as RGB black with alpha 0 while the
    PMX material itself still has alpha 1. Exporting such a texture as OPAQUE
    turns those transparent pixels into visible black patches. Read the image
    alpha once during conversion (not at runtime) and choose MASK for hard
    cut-outs or BLEND where the source contains genuinely translucent pixels.
    """
    if image is None or not image.has_data or int(image.channels) < 4:
        return None
    channels = int(image.channels)
    pixel_count = int(image.size[0] * image.size[1] * channels)
    if pixel_count <= 0:
        return None
    values = array("f", [0.0]) * pixel_count
    image.pixels.foreach_get(values)
    alpha = values[3::channels]
    if not alpha:
        return None
    minimum = min(alpha)
    maximum = max(alpha)
    # A few PMX exporters write an almost-opaque alpha value to every texel
    # (for example 0.89..0.98 on a skin atlas). Treat that as opaque; making
    # an entire body material transparent is both lower quality and prone to
    # depth-order artefacts in a transparent desktop window.
    if minimum >= 0.80:
        return None
    zero_count = sum(1 for value in alpha if value <= 0.01)
    mid_count = sum(1 for value in alpha if 0.01 < value < 0.99)
    zero_ratio = zero_count / max(1, len(alpha))
    mid_ratio = mid_count / max(1, len(alpha))
    if zero_count == 0:
        return None
    # Hair cards, eye decals and lace use a mostly binary alpha with a small
    # anti-aliased edge. MASK keeps depth writes enabled and avoids the
    # front-half-of-clothing disappearance caused by BLEND sorting. Reserve
    # BLEND for genuinely translucent images with a substantial soft-alpha
    # area and no reliable cut-out boundary.
    if maximum >= 0.99 and (mid_ratio <= 0.08 or zero_ratio >= 0.20):
        return "MASK"
    return "BLEND"


def configure_mtoon_materials() -> dict[str, int]:
    converted = 0
    with_sphere_map = 0
    with_outline = 0
    alpha_masked = 0
    alpha_blended = 0
    for material in bpy.data.materials:
        if not material or not material.node_tree:
            continue
        nodes = material.node_tree.nodes
        base_node = nodes.get("mmd_base_tex")
        sphere_node = nodes.get("mmd_sphere_tex")
        base_image = getattr(base_node, "image", None)
        sphere_image = getattr(sphere_node, "image", None)
        mmd = getattr(material, "mmd_material", None)
        if mmd is None:
            continue
        diffuse = tuple(float(value) for value in mmd.diffuse_color[:3])
        ambient = tuple(float(value) for value in mmd.ambient_color[:3])
        alpha = float(mmd.alpha)
        sphere_type = int(mmd.sphere_texture_type)
        edge_enabled = bool(mmd.enabled_toon_edge)
        edge_color = tuple(float(value) for value in mmd.edge_color[:3])
        edge_weight = float(mmd.edge_weight)

        result = bpy.ops.vrm.convert_material_to_mtoon1(material_name=material.name)
        if result != {"FINISHED"}:
            continue
        gltf = material.vrm_addon_extension.mtoon1
        gltf.enabled = True
        mtoon = gltf.extensions.vrmc_materials_mtoon
        gltf.pbr_metallic_roughness.base_color_factor = (*diffuse, alpha)
        if base_image:
            gltf.pbr_metallic_roughness.base_color_texture.index.source = base_image
            mtoon.shade_multiply_texture.index.source = base_image
        # MMD's toon ramp is view-normal sampled and cannot be copied as an
        # ordinary UV texture. Its ambient colour is a closer MToon shade
        # equivalent and preserves depth without baking away source detail.
        mtoon.shade_color_factor = tuple(max(0.12, min(1.0, value)) for value in ambient)
        mtoon.shading_shift_factor = -0.05
        mtoon.shading_toony_factor = 0.92
        mtoon.gi_equalization_factor = 0.90
        gltf.double_sided = bool(mmd.is_double_sided)
        detected_alpha_mode = image_alpha_mode(base_image)
        # Facial decals are very thin overlays. Keep their anti-aliased edges
        # blended for the original soft look; clothing, hair cards and shoes
        # use the MASK result above so their depth remains stable.
        material_name_lower = material.name.lower()
        if detected_alpha_mode == "MASK" and any(
            token in material_name_lower for token in ("eye", "brow", "eyeline", "mouth")
        ):
            detected_alpha_mode = "BLEND"
        if detected_alpha_mode:
            gltf.alpha_mode = detected_alpha_mode
            if detected_alpha_mode == "MASK":
                gltf.alpha_cutoff = 0.5
                alpha_masked += 1
            else:
                alpha_blended += 1
        elif alpha < 0.999:
            gltf.alpha_mode = "BLEND"
            alpha_blended += 1

        if sphere_image and sphere_type in {1, 2}:
            mtoon.matcap_texture.index.source = sphere_image
            # Additive SPA maps transfer directly. Multiplicative SPH maps have
            # no exact VRM 1.0 equivalent, so keep a restrained contribution.
            mtoon.matcap_factor = (1.0, 1.0, 1.0) if sphere_type == 2 else (0.28, 0.28, 0.28)
            with_sphere_map += 1

        if edge_enabled and edge_weight > 0.0001:
            mtoon.outline_width_mode = "screenCoordinates"
            mtoon.outline_width_factor = min(0.0045, max(0.0007, edge_weight * 0.0018))
            mtoon.outline_color_factor = edge_color
            mtoon.outline_lighting_mix_factor = 0.12
            with_outline += 1
        else:
            mtoon.outline_width_mode = "none"
        converted += 1
    return {
        "converted": converted,
        "withSphereMap": with_sphere_map,
        "withOutline": with_outline,
        "alphaMasked": alpha_masked,
        "alphaBlended": alpha_blended,
    }


def select_export_objects(armature: bpy.types.Object) -> int:
    bpy.ops.object.select_all(action="DESELECT")
    selected = 0
    for obj in bpy.data.objects:
        armature_driven_mesh = obj.type == "MESH" and (
            obj.parent == armature
            or any(
                modifier.type == "ARMATURE" and modifier.object == armature
                for modifier in obj.modifiers
            )
        )
        # MMD Tools represents rigid bodies as hidden mesh objects. They are
        # converted above into VRM spring colliders and must not be exported as
        # visible geometry. Selecting every mesh would produce giant boxes or
        # capsules around an otherwise correct character.
        if armature_driven_mesh or obj == armature:
            obj.hide_set(False)
            obj.hide_render = False
            obj.select_set(True)
            selected += 1
    bpy.context.view_layer.objects.active = armature
    return selected


def export_vrm(output_path: Path, armature: bpy.types.Object) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.vrm(
        filepath=str(output_path),
        export_invisibles=False,
        export_only_selections=True,
        enable_advanced_preferences=True,
        export_all_influences=True,
        export_lights=False,
        export_gltf_animations=False,
        export_try_sparse_sk=True,
        armature_object_name=armature.name,
        ignore_warning=True,
    )
    if result != {"FINISHED"}:
        raise RuntimeError(f"VRM export failed: {sorted(result)}")
    if not output_path.is_file() or output_path.stat().st_size < 20:
        raise RuntimeError("VRM exporter did not create a valid output file")


def main() -> None:
    input_path, output_path, report_path, compatibility_mode = arguments()
    report: dict[str, object] = {
        "result": "FAIL",
        "input": str(input_path),
        "output": str(output_path),
        "blender": bpy.app.version_string,
        "compatibilityMode": compatibility_mode,
        "stage": "input-validation",
    }
    try:
        if input_path.suffix.lower() != ".pmx" or not input_path.is_file():
            raise RuntimeError("Input must be an existing .pmx file")
        report["stage"] = "addon-setup"
        enable_converter_addons()
        if compatibility_mode:
            enable_crash_compatibility_mode()
        clear_scene()
        report["stage"] = "pmx-import"
        import_pmx(input_path)
        report.update(getattr(import_pmx, "texture_diagnostics", {}))
        report["stage"] = "humanoid-mapping"
        armature = find_armature()
        report["stage"] = "skin-binding-check"
        skin_bindings = audit_and_repair_skin_bindings(armature)
        report["skinBindings"] = skin_bindings
        assigned = assign_humanoid(armature)
        missing = sorted(REQUIRED_HUMAN_BONES - set(assigned))
        if missing:
            raise RuntimeError("Missing required humanoid bones: " + ", ".join(missing))
        configure_metadata(armature, input_path)
        report["stage"] = "garment-and-material-setup"
        springs = configure_spring_bones(armature)
        sleeve_rig = add_unrigged_sleeve_springs(armature, assigned)
        garment_collisions = add_garment_collisions(armature)
        materials = configure_mtoon_materials()
        selected = select_export_objects(armature)
        report["stage"] = "vrm-export"
        export_vrm(output_path, armature)
        report.update(
            {
                "result": "PASS",
                "stage": "complete",
                "armature": armature.name,
                "armatureBones": len(armature.data.bones),
                "meshObjects": sum(1 for obj in bpy.data.objects if obj.type == "MESH"),
                "selectedObjects": selected,
                "humanBones": assigned,
                "skinBindings": skin_bindings,
                "springBones": springs,
                "generatedSleeveRig": sleeve_rig,
                "garmentCollisions": garment_collisions,
                "mtoonMaterials": materials,
                "outputBytes": output_path.stat().st_size,
            }
        )
        write_report(report_path, report)
        print("YACHIYO_PMX_CONVERSION_PASS " + json.dumps(report, ensure_ascii=False))
    except Exception as error:
        report.update(getattr(import_pmx, "texture_diagnostics", {}))
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()
        write_report(report_path, report)
        if output_path.exists():
            output_path.unlink()
        print("YACHIYO_PMX_CONVERSION_FAIL " + json.dumps(report, ensure_ascii=False), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
