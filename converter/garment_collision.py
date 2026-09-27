"""Conservative VRM spring-bone collision links for PMX clothing.

Spring bones collide at their joint tails, not triangle against triangle. These
proxies reduce *motion-induced* sleeve/skirt intersections; they cannot repair
intersections already present in the PMX bind pose or bad skin weights.
"""

from __future__ import annotations

import bpy


def _link(spring, group_uuid: str) -> bool:
    if any(ref.collider_group_uuid == group_uuid for ref in spring.collider_groups):
        return False
    spring.add_collider_group().collider_group_uuid = group_uuid
    return True


def add_garment_collisions(armature: bpy.types.Object) -> dict[str, int]:
    data = armature.data.vrm_addon_extension.spring_bone1
    sleeves = [spring for spring in data.springs if spring.vrm_name.startswith("AutoSleeve_")]
    skirts = [spring for spring in data.springs if spring.joints and
              any(token in spring.joints[0].node.bone_name.casefold() for token in ("skirt", "スカート", "裙", "dress", "裾"))]
    if not skirts:
        return {"skirtProxies": 0, "sleeveLinks": 0, "armSkirtLinks": 0,
                "thighProxies": 0, "thighSkirtLinks": 0}

    # VRM springs test joint tails against collider volumes, not cloth triangles.
    # A thigh capsule on every skirt rib pushed the entire garment outward even
    # when idle. Do not generate thigh colliders until a local cloth solver can
    # distinguish the contact panels from the opposite side of the skirt.
    thigh_proxies = thigh_skirt_links = 0

    # Arm-to-skirt collision would apply the same hand volume to every rib of
    # a narrow skirt. At neutral it inflated the whole garment like a bell.
    # There is no local triangle contact in VRM spring bones, so do not add it.
    arm_skirt_links = 0

    # Only sleeves generated from clearly identified loose sleeve materials
    # receive skirt proxies. An authored sleeve system may already have its own
    # colliders, so it is not second-guessed here.
    proxy_count = sleeve_links = 0
    for side in ("left", "right"):
        side_springs = [spring for spring in sleeves if spring.vrm_name.startswith(f"AutoSleeve_{side}_")]
        lower_bones = [armature.data.bones.get(spring.joints[-1].node.bone_name) for spring in side_springs]
        lower_bones = [bone for bone in lower_bones if bone is not None]
        if not lower_bones:
            continue
        # Find skirt ribs on the same side near the free sleeve end. Nearest
        # selection avoids assuming any fixed PMX bone numbering or orientation.
        anchor = sum((bone.head_local for bone in lower_bones), lower_bones[0].head_local.copy() * 0) / len(lower_bones)
        sign = 1 if anchor.x >= 0 else -1
        candidates = []
        for skirt in skirts:
            for joint in skirt.joints[1:]:
                bone = armature.data.bones.get(joint.node.bone_name)
                if bone and bone.head_local.x * sign > 0.08 and abs(bone.head_local.z - anchor.z) < 0.24:
                    distance = (bone.head_local - anchor).length
                    candidates.append((distance, bone.name))
        closest = [name for _, name in sorted(candidates)[:4]]
        if not closest:
            continue
        group = data.add_collider_group()
        group.vrm_name = f"AutoGarment_{side}_skirt_contact"
        for name in dict.fromkeys(closest):
            collider = data.add_collider(bpy.context, armature)
            collider.node.bone_name = name
            collider.shape_type = collider.SHAPE_TYPE_SPHERE.identifier
            collider.shape.sphere.offset = (0.0, 0.0, 0.0)
            collider.shape.sphere.radius = 0.095
            group.add_collider().collider_uuid = collider.uuid
            proxy_count += 1
        sleeve_links += sum(_link(spring, group.uuid) for spring in side_springs)
    return {"skirtProxies": proxy_count, "sleeveLinks": sleeve_links,
            "armSkirtLinks": arm_skirt_links, "thighProxies": thigh_proxies,
            "thighSkirtLinks": thigh_skirt_links}
