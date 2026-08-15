#!/usr/bin/env python3
"""Dump a rigged GLB's per-frame bone data as JSON for offline loop analysis
(factory v2 手順 2 — the 3D-master ledger's bone-signature gate).

Runs under headless Blender (the spike_tripo_render.py precedent):

    blender -b -P scripts/factory/bpy_dump_bones.py -- <glb> <out.json>

Sampling is on a SUBSTEPS-per-frame grid (frame_set's subframe evaluation —
verified to interpolate poses, 2026-08-14): Meshy motion clips are authored
at their own rate, so at the pipeline's 24fps the true cycle length is
fractional (walking measures ~24.8 frames) and integer-frame sampling alone
would fold a spurious sub-frame seam into every closure measurement. The
grid also extends one frame past the action end, where evaluation clamps to
the last key — for an exactly-loopable export that clamp region carries the
wrap pose.

Two per-sample records feed bone_signature.py:
  - signatures: every pose bone's matrix_basis quaternion + translation
    (the pose self-similarity signal spike_tripo_render's `analyze`
    established for loop discovery — unlike silhouette IoU it distinguishes
    the mirrored half-steps of a 3/4-view chibi, 運転知見 22)
  - world: L/R foot world-space head positions plus every bone (the gait
    full-cycle check reads the feet)
"""

from __future__ import annotations

import json
import sys

import bpy

SUBSTEPS = 4


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) != 2:
        raise SystemExit(__doc__)
    glb_path, out_path = argv

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)

    actions = list(bpy.data.actions)
    if len(actions) != 1:
        raise SystemExit(
            f"expected exactly one action in {glb_path}, found "
            f"{[a.name for a in actions]} — pick explicitly before dumping"
        )
    action = actions[0]
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    armature.animation_data_create().action = action

    scene = bpy.context.scene
    frame_start = int(action.frame_range[0])
    # One frame of clamp margin past the last key (see the module doc).
    frame_end = int(action.frame_range[1]) + 1

    bones = [pb.name for pb in armature.pose.bones]
    signatures: list[list[float]] = []
    world: dict[str, list[list[float]]] = {name: [] for name in bones}
    times: list[float] = []
    for index in range((frame_end - frame_start) * SUBSTEPS + 1):
        frame = frame_start + index // SUBSTEPS
        subframe = (index % SUBSTEPS) / SUBSTEPS
        scene.frame_set(frame, subframe=subframe)
        times.append(frame + subframe)
        values: list[float] = []
        for pb in armature.pose.bones:
            values.extend(pb.matrix_basis.to_quaternion())
            values.extend(pb.matrix_basis.to_translation())
            head = armature.matrix_world @ pb.head
            world[pb.name].append([head.x, head.y, head.z])
        signatures.append(values)

    with open(out_path, "w") as handle:
        json.dump(
            {
                "glb": glb_path,
                "action": action.name,
                "fps": scene.render.fps,
                "substeps": SUBSTEPS,
                "frameStart": frame_start,
                "frameEnd": frame_end,
                "times": times,
                "bones": bones,
                "signatures": signatures,
                "world": world,
            },
            handle,
        )
    print(f"BONE DUMP {len(times)} samples ({SUBSTEPS}/frame) -> {out_path}")


if __name__ == "__main__":
    main()
