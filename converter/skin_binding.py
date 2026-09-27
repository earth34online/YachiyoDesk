"""Conservative PMX skin-binding audit and unambiguous one-ring repair.

Only isolated zero-weight holes are repaired. Mirrored bones, sleeves, skirt
panels and other multi-bone boundaries are never guessed from spatial nearest
bones; that approach can destroy an otherwise correct imported model.
"""

from __future__ import annotations

import bpy


MIN_WEIGHT = 1e-5
MAX_SAFE_EDGE = 0.045  # Blender import scale 0.08, roughly 4.5 cm on a human.


def _deform_weights(vertex: bpy.types.MeshVertex, deform_groups: set[int]) -> dict[int, float]:
    return {item.group: item.weight for item in vertex.groups
            if item.group in deform_groups and item.weight > MIN_WEIGHT}


def _dominant(weights: dict[int, float]) -> tuple[int, float] | None:
    if not weights:
        return None
    total = sum(weights.values())
    group, value = max(weights.items(), key=lambda item: item[1])
    return (group, value / total) if total > MIN_WEIGHT else None


def audit_and_repair_skin_bindings(armature: bpy.types.Object) -> dict[str, object]:
    report: dict[str, object] = {
        "skinnedMeshes": 0,
        "verticesChecked": 0,
        "zeroWeightVertices": 0,
        "repairedVertices": 0,
        "unresolvedVertices": 0,
        "invalidBoneWeightVertices": 0,
        "nonUnitWeightVertices": 0,
        "meshes": [],
        "warnings": [],
    }
    all_bone_names = {bone.name for bone in armature.data.bones}
    bone_names = {bone.name for bone in armature.data.bones if bone.use_deform}
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not any(
            modifier.type == "ARMATURE" and modifier.object == armature
            for modifier in obj.modifiers
        ):
            continue
        deform_groups = {group.index for group in obj.vertex_groups if group.name in bone_names}
        invalid_groups = {group.index for group in obj.vertex_groups
                          if group.name not in all_bone_names and not group.name.startswith("mmd_")}
        vertices = obj.data.vertices
        weighted = [_deform_weights(vertex, deform_groups) for vertex in vertices]
        holes = [vertex.index for vertex in vertices if not weighted[vertex.index]]
        neighbors: dict[int, set[int]] = {index: set() for index in holes}
        for polygon in obj.data.polygons:
            corners = tuple(polygon.vertices)
            for index in corners:
                if index in neighbors:
                    neighbors[index].update(other for other in corners if other != index)

        repaired = 0
        for index in holes:
            nearby = [other for other in neighbors[index]
                      if weighted[other]
                      and (vertices[index].co - vertices[other].co).length <= MAX_SAFE_EDGE]
            if len(nearby) < 2:
                continue
            dominant = [_dominant(weighted[other]) for other in nearby]
            # Do not propagate a rigid/single-bone weight across a blend seam.
            if any(item is None or item[1] < 0.70 for item in dominant):
                continue
            if len({item[0] for item in dominant}) != 1:
                continue
            average: dict[int, float] = {}
            for other in nearby:
                for group, value in weighted[other].items():
                    average[group] = average.get(group, 0.0) + value / len(nearby)
            total = sum(average.values())
            if total <= MIN_WEIGHT:
                continue
            for group, value in average.items():
                if value / total > MIN_WEIGHT:
                    obj.vertex_groups[group].add([index], value / total, "REPLACE")
            repaired += 1

        invalid = sum(any(group.group in invalid_groups and group.weight > MIN_WEIGHT
                          for group in vertex.groups) for vertex in vertices)
        non_unit = sum(bool(values) and abs(sum(values.values()) - 1.0) > 0.025 for values in weighted)
        unresolved = len(holes) - repaired
        mesh_report = {
            "name": obj.name,
            "vertices": len(vertices),
            "zeroWeight": len(holes),
            "repaired": repaired,
            "unresolved": unresolved,
            "invalidBoneWeight": invalid,
            "invalidGroupNames": [group.name for group in obj.vertex_groups
                                  if group.index in invalid_groups][:12],
            "nonUnitWeight": non_unit,
        }
        report["meshes"].append(mesh_report)
        report["skinnedMeshes"] += 1
        report["verticesChecked"] += len(vertices)
        report["zeroWeightVertices"] += len(holes)
        report["repairedVertices"] += repaired
        report["unresolvedVertices"] += unresolved
        report["invalidBoneWeightVertices"] += invalid
        report["nonUnitWeightVertices"] += non_unit
        if unresolved or invalid:
            report["warnings"].append(
                f"{obj.name}: {unresolved} 个顶点无法安全自动补权重，{invalid} 个顶点引用无效骨骼组"
            )
    return report
