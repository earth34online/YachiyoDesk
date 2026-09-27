"""Blender integration test: blender --background --factory-startup --python converter/test_skin_binding.py"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skin_binding import audit_and_repair_skin_bindings


def make_mesh(name: str, armature: bpy.types.Object, ambiguous: bool) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(0.0, 0.0, 0.0), (0.02, 0.0, 0.0), (0.0, 0.02, 0.0), (-0.02, 0.0, 0.0)],
        [],
        [(0, 1, 2), (0, 2, 3), (0, 3, 1)],
    )
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.modifiers.new("Armature", "ARMATURE").object = armature
    first = obj.vertex_groups.new(name="BoneA")
    second = obj.vertex_groups.new(name="BoneB")
    first.add([1, 2] if ambiguous else [1, 2, 3], 1.0, "REPLACE")
    if ambiguous:
        second.add([3], 1.0, "REPLACE")
    obj.vertex_groups.new(name="mmd_edge_scale").add([0, 1, 2, 3], 0.5, "REPLACE")
    return obj


bpy.ops.object.armature_add()
armature = bpy.context.object
armature.data.bones[0].name = "BoneA"
bpy.ops.object.mode_set(mode="EDIT")
bone = armature.data.edit_bones.new("BoneB")
bone.head = (0.0, 0.0, 0.0)
bone.tail = (0.0, 0.1, 0.0)
bpy.ops.object.mode_set(mode="OBJECT")
safe = make_mesh("safe", armature, False)
ambiguous = make_mesh("ambiguous", armature, True)
unbound_mesh = bpy.data.meshes.new("unbound")
unbound_mesh.from_pydata([(0.0, 0.0, 0.0), (0.02, 0.0, 0.0), (0.0, 0.02, 0.0)], [], [(0, 1, 2)])
unbound = bpy.data.objects.new("unbound", unbound_mesh)
bpy.context.scene.collection.objects.link(unbound)
unbound.modifiers.new("Armature", "ARMATURE").object = armature
report = audit_and_repair_skin_bindings(armature)
assert report["skinnedMeshes"] == 3, report
assert report["zeroWeightVertices"] == 5, report
assert report["repairedVertices"] == 1, report
assert report["unresolvedVertices"] == 4, report
assert report["invalidBoneWeightVertices"] == 0, report
assert any(item.group == safe.vertex_groups["BoneA"].index for item in safe.data.vertices[0].groups)
assert not any(item.group in {ambiguous.vertex_groups["BoneA"].index,
                              ambiguous.vertex_groups["BoneB"].index}
               for item in ambiguous.data.vertices[0].groups)
print("YACHIYO_SKIN_BINDING_TEST_PASS")
