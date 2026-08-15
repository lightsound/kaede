#!/usr/bin/env python3
"""Render the ARM-ID map of a rigged GLB's verified loop window
(factory v2 手順 3 — the 3rd layer's arm-mask renderer, §2.1 of
docs/factory-v2-plan.md).

Same camera, same sub-frame loop sampling, same argument contract as
bpy_render_loop.py (the green-reference renderer) — invoked with the SAME
ledger loop window, every ID frame is pixel-aligned with the reference the
clean-up model was conditioned on (verified: silhouette IoU 0.97 vs the
committed walk-carry/boy reference, the residue being a 1px mp4-encode edge
ring). What differs is only the materials: instead of the flat base-color
emission, every mesh face is assigned one of three flat emission IDs by the
majority VERTEX-GROUP side of its vertices —

    white (255,255,255)  body (everything not on an arm chain)
    red   (255,0,0)      left-arm chain  (LeftArm / LeftForeArm / LeftHand)
    blue  (0,0,255)      right-arm chain (RightArm / RightForeArm / RightHand)

so the render is a visible-surface partition of the character into
body / left arm / right arm that natively encodes occlusion (an arm pixel
hidden behind the torso simply is not an arm pixel in the map). Shoulders
(clavicles) count as body: their vertices are torso cloth, and the split
only needs to be item-accurate around the forearms/hands where a held item
overlaps. Meshes without vertex groups (the Texting GLB carries a stray
invisible Icosphere) render as body, keeping the scene byte-identical to
the reference render's.

Which chain is the NEAR arm is decided downstream from the dumped bone
depths (bones.json also records each hand bone's camera-space depth); the
map itself stays side-agnostic.

Usage (identical window arguments as the reference render):

    blender -b --python-exit-code 1 -P scripts/factory/bpy_render_arm_ids.py \
        -- <glb> <outdir> --start-time F --span L --frames N \
        [--yaw 45] [--resolution 720]

Writes ids_<index>.png per sample plus bones.json: per-sample 2D pixel
projections (and camera depth) of the elbow (ForeArm head) and wrist
(Hand head) joints of both arms — the machine source for hand anchors
(replaces the measured handAnchors of the skin-heuristic era). Only bone
HEADS are dumped: glTF leaf bones (the hands here) get importer-invented
tails, so tail positions are garbage by construction.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bpy  # noqa: E402
from bpy_extras.object_utils import world_to_camera_view  # noqa: E402
from factory.bpy_render_loop import (  # noqa: E402
    fit_camera_over_times,
    load_single_action,
    loop_parser,
    set_time,
)
from factory.spike_tripo_render import setup_render  # noqa: E402

LEFT_CHAIN = {"LeftArm", "LeftForeArm", "LeftHand"}
RIGHT_CHAIN = {"RightArm", "RightForeArm", "RightHand"}
ID_COLORS = {0: (1.0, 1.0, 1.0), 1: (1.0, 0.0, 0.0), 2: (0.0, 0.0, 1.0)}
JOINT_BONES = ("LeftForeArm", "LeftHand", "RightForeArm", "RightHand")


def id_material(name: str, rgb: tuple[float, float, float]):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*rgb, 1.0)
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def vertex_side(vertex, names: dict[int, str]) -> int:
    """0 body / 1 left chain / 2 right chain by dominant weight sum."""
    weights = [0.0, 0.0, 0.0]
    for grp in vertex.groups:
        name = names.get(grp.group)
        if name in LEFT_CHAIN:
            weights[1] += grp.weight
        elif name in RIGHT_CHAIN:
            weights[2] += grp.weight
        else:
            weights[0] += grp.weight
    return max(range(3), key=lambda i: weights[i])


def assign_id_materials() -> None:
    """Replace every mesh's materials with the three flat ID emissions."""
    materials = [id_material(f"armid_{i}", rgb) for i, rgb in ID_COLORS.items()]
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.materials.clear()
        for mat in materials:
            mesh.materials.append(mat)
        names = {g.index: g.name for g in obj.vertex_groups}
        if not names:
            for poly in mesh.polygons:
                poly.material_index = 0
            continue
        sides = [vertex_side(v, names) for v in mesh.vertices]
        for poly in mesh.polygons:
            counts = [0, 0, 0]
            for vi in poly.vertices:
                counts[sides[vi]] += 1
            poly.material_index = max(range(3), key=lambda i: counts[i])


def hand_projections(resolution: int) -> dict:
    """Pixel-space joint heads (elbow/wrist per arm) + camera depth."""
    scene = bpy.context.scene
    camera = scene.camera
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    out: dict[str, list[float]] = {}
    for name in JOINT_BONES:
        world = armature.matrix_world @ armature.pose.bones[name].head
        ndc = world_to_camera_view(scene, camera, world)
        out[name] = [
            round(ndc.x * resolution, 2),
            round((1 - ndc.y) * resolution, 2),
            round(ndc.z, 4),
        ]
    return out


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = loop_parser().parse_args(argv)

    load_single_action(args.glb)
    assign_id_materials()
    setup_render(args.resolution)
    scene = bpy.context.scene

    times = [args.start_time + i * args.span / args.frames for i in range(args.frames)]
    fit_camera_over_times(times, args.yaw)

    bones: list[dict] = []
    for index, time in enumerate(times):
        set_time(time)
        scene.render.filepath = f"{args.outdir}/ids_{index:02d}.png"
        bpy.ops.render.render(write_still=True)
        bones.append({"index": index, "time": round(time, 4), **hand_projections(args.resolution)})
        print(f"rendered ids {index} @ t={time:.2f}")
    (Path(args.outdir) / "bones.json").write_text(
        json.dumps({"resolution": args.resolution, "samples": bones}, indent=1) + "\n"
    )
    print("ARM ID RENDER DONE")


if __name__ == "__main__":
    main()
