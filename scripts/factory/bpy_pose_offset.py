#!/usr/bin/env python3
"""Compose constant local-rotation offsets into a rigged GLB's action
(the carry-v3 shoulder/elbow surgery — 運転知見 22 — as a reusable tool;
first production use: raising the Texting_Walk head so the carry master
does not stare at a phone, owner order 2026-08-16).

Every keyframe of the named bones' rotation_quaternion fcurves is
pre-multiplied by the offset quaternion (a rotation about the bone's
rest-pose local axis), so the motion's timing, feet and loop closure are
untouched — only the posture changes by a constant.

    blender -b --python-exit-code 1 -P scripts/factory/bpy_pose_offset.py \
        -- <in.glb> <out.glb> --offset Head=X:-20 [--offset neck=X:-8]
"""

from __future__ import annotations

import sys

from mathutils import Quaternion

import bpy


def main() -> None:
    import argparse
    import math

    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb_in")
    parser.add_argument("glb_out")
    parser.add_argument(
        "--offset", action="append", required=True,
        help="Bone=Axis:degrees (Axis in XYZ, bone-local)",
    )
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.glb_in)
    actions = list(bpy.data.actions)
    if len(actions) != 1:
        raise SystemExit(f"expected exactly one action, found {[a.name for a in actions]}")
    action = actions[0]

    for spec in args.offset:
        bone, _, rest = spec.partition("=")
        axis, _, degrees = rest.partition(":")
        offset = Quaternion(
            {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[axis.upper()],
            math.radians(float(degrees)),
        )
        path = f'pose.bones["{bone}"].rotation_quaternion'
        curves = sorted(
            (c for c in action.fcurves if c.data_path == path),
            key=lambda c: c.array_index,
        )
        if len(curves) != 4:
            raise SystemExit(f"{bone}: found {len(curves)} quaternion fcurves, expected 4")
        counts = {len(c.keyframe_points) for c in curves}
        if len(counts) != 1:
            raise SystemExit(f"{bone}: quaternion fcurves disagree on keyframe count {counts}")
        for i in range(counts.pop()):
            times = {c.keyframe_points[i].co.x for c in curves}
            if len(times) != 1:
                raise SystemExit(f"{bone}: keyframe {i} times diverge {times}")
            q = Quaternion([c.keyframe_points[i].co.y for c in curves])
            q_new = offset @ q
            for c, value in zip(curves, q_new):
                c.keyframe_points[i].co.y = value
        for c in curves:
            c.update()
        print(f"offset {bone} {axis}{degrees} over {len(curves[0].keyframe_points)} keys")

    bpy.ops.export_scene.gltf(
        filepath=args.glb_out, export_format="GLB", export_animations=True
    )
    print("POSE OFFSET DONE")


if __name__ == "__main__":
    main()
