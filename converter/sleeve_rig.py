"""Conservative auxiliary sleeve rigging for PMX garments without sleeve bones.

This operates in Blender armature-local rest coordinates. It never changes a
humanoid bone, never edits an authored sleeve chain, and affects only vertices
belonging to explicitly sleeve-named materials that already follow an elbow.
"""

from __future__ import annotations

import bpy
from mathutils import Vector


SLEEVE_TOKENS = ("sleeve", "袖", "cuff", "カフス")


def _smoothstep(value: float) -> float:
    amount = max(0.0, min(1.0, value))
    return amount * amount * (3.0 - 2.0 * amount)


def _weight(vertex: bpy.types.MeshVertex, group_index: int) -> float:
    return next((item.weight for item in vertex.groups if item.group == group_index), 0.0)


def add_unrigged_sleeve_springs(armature: bpy.types.Object, assigned: dict[str, str]) -> dict[str, object]:
    spring_bone = armature.data.vrm_addon_extension.spring_bone1
    existing_names = {bone.name.casefold() for bone in armature.data.bones}
    existing_springs = {
        spring.joints[0].node.bone_name.casefold()
        for spring in spring_bone.springs if spring.joints
    }
    if any(any(token in name for token in SLEEVE_TOKENS) for name in existing_names | existing_springs):
        return {"generatedChains": 0, "affectedVertices": 0, "reason": "authored-sleeve-bones-present"}

    candidates = []
    inverse_armature_world = armature.matrix_world.inverted()
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not (
            obj.parent == armature
            or any(mod.type == "ARMATURE" and mod.object == armature for mod in obj.modifiers)
        ):
            continue
        material_indices = {
            index for index, material in enumerate(obj.data.materials)
            if material and any(token in material.name.casefold() for token in SLEEVE_TOKENS)
        }
        if not material_indices:
            continue
        sleeve_ids = {
            vertex_index
            for polygon in obj.data.polygons if polygon.material_index in material_indices
            for vertex_index in polygon.vertices
        }
        to_armature = inverse_armature_world @ obj.matrix_world
        for side in ("left", "right"):
            elbow_name = assigned.get(f"{side}LowerArm")
            elbow = armature.data.bones.get(elbow_name) if elbow_name else None
            elbow_group = obj.vertex_groups.get(elbow_name) if elbow_name else None
            if not elbow or not elbow_group:
                continue
            selected = [
                (index, to_armature @ obj.data.vertices[index].co)
                for index in sleeve_ids
                if _weight(obj.data.vertices[index], elbow_group.index) >= 0.25
            ]
            if len(selected) < 80:
                continue
            heights = sorted(point.z for _, point in selected)
            bottom_z = heights[max(0, int(len(heights) * 0.08))]
            top_z = heights[min(len(heights) - 1, int(len(heights) * 0.92))]
            # A narrow fitted sleeve should keep its authored elbow skin. Only
            # a long hanging cuff has enough geometry for a smooth spring bend.
            if top_z - bottom_z < 0.16 or elbow.head_local.z - bottom_z < 0.17:
                continue
            distal_points = [point for _, point in selected if point.z <= bottom_z + 0.045]
            distal = sum(distal_points, Vector((0.0, 0.0, 0.0))) / len(distal_points)
            if (distal - elbow.head_local).length < 0.16:
                continue
            candidates.append((obj, side, elbow.name, elbow.head_local.copy(), distal, selected, bottom_z, top_z))

    if not candidates:
        return {"generatedChains": 0, "affectedVertices": 0, "reason": "no-safe-hanging-sleeve"}

    # Bone topology is created in Edit Mode; weights are assigned only after
    # returning to Object Mode. New bones are descendants of the original
    # elbow, so unchanged source vertices keep their original transform.
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    prepared = []
    for index, (obj, side, elbow_name, head, distal, selected, bottom_z, top_z) in enumerate(candidates):
        # A single chain makes the entire wide cuff rotate like a board. Split
        # only genuinely broad hanging sleeves into two soft longitudinal ribs
        # so their front and rear fabric can lag independently. Narrow sleeves
        # retain the old single-chain treatment.
        ys = sorted(point.y for _, point in selected)
        low_y = ys[int(len(ys) * 0.25)]
        high_y = ys[int(len(ys) * 0.75)]
        distal_points = [point for _, point in selected if point.z <= bottom_z + 0.055]
        lower_half = [point for point in distal_points if point.y <= (low_y + high_y) * 0.5]
        upper_half = [point for point in distal_points if point.y > (low_y + high_y) * 0.5]
        if high_y - low_y >= 0.065 and len(lower_half) >= 12 and len(upper_half) >= 12:
            sectors = [("back", lower_half), ("front", upper_half)]
        else:
            sectors = [("whole", distal_points)]
        chain_names = []
        for sector_name, points in sectors:
            sector_distal = sum(points, Vector((0.0, 0.0, 0.0))) / len(points)
            prefix = f"AutoSleeve_{side}_{index}_{sector_name}"
            mid = head.lerp(sector_distal, 0.54)
            tip = sector_distal + (sector_distal - mid) * 0.32
            first = armature.data.edit_bones.new(prefix + "_upper")
            first.parent = armature.data.edit_bones[elbow_name]
            first.head = head
            first.tail = mid
            second = armature.data.edit_bones.new(prefix + "_lower")
            second.parent = first
            second.use_connect = True
            second.head = mid
            second.tail = sector_distal
            end = armature.data.edit_bones.new(prefix + "_tip")
            end.parent = second
            end.use_connect = True
            end.head = sector_distal
            end.tail = tip
            end.use_deform = False
            chain_names.append((first.name, second.name, end.name))
        prepared.append((obj, elbow_name, selected, bottom_z, top_z, low_y, high_y, chain_names))
    bpy.ops.object.mode_set(mode="OBJECT")

    affected = 0
    chain_count = 0
    for obj, elbow_name, selected, bottom_z, top_z, low_y, high_y, chain_names in prepared:
        elbow_group = obj.vertex_groups[elbow_name]
        groups = [(obj.vertex_groups.new(name=upper), obj.vertex_groups.new(name=lower))
                  for upper, lower, _ in chain_names]
        for vertex_index, point in selected:
            source_weight = _weight(obj.data.vertices[vertex_index], elbow_group.index)
            progress = _smoothstep((top_z - point.z) / max(0.001, top_z - bottom_z))
            share = 0.62 * progress
            if share < 0.005:
                continue
            elbow_group.add([vertex_index], source_weight * (1.0 - share), "REPLACE")
            fractions = ((1.0 - _smoothstep((point.y - low_y) / max(0.001, high_y - low_y)),
                          _smoothstep((point.y - low_y) / max(0.001, high_y - low_y)))
                         if len(groups) == 2 else (1.0,))
            for (upper_group, lower_group), fraction in zip(groups, fractions):
                if fraction <= 0.001:
                    continue
                upper_weight = source_weight * share * fraction * (1.0 - progress)
                lower_weight = source_weight * share * fraction * progress
                if upper_weight > 0.0001:
                    upper_group.add([vertex_index], upper_weight, "REPLACE")
                if lower_weight > 0.0001:
                    lower_group.add([vertex_index], lower_weight, "REPLACE")
            affected += 1
        for upper_name, lower_name, tip_name in chain_names:
            spring = spring_bone.add_spring()
            spring.vrm_name = upper_name
            for name, stiffness, gravity in (
                (upper_name, 0.82, 0.028),
                (lower_name, 0.70, 0.050),
                (tip_name, 0.70, 0.050),
            ):
                joint = spring.add_joint()
                joint.node.bone_name = name
                joint.stiffness = stiffness
                joint.gravity_power = gravity
                joint.drag_force = 0.56
                joint.hit_radius = 0.003
            chain_count += 1
    return {"generatedChains": chain_count, "affectedVertices": affected, "reason": "generated"}
