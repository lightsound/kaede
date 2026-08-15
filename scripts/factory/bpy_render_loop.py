#!/usr/bin/env python3
"""Render one verified loop window of a rigged GLB to sprite frames
(factory v2 手順 2 — the 3D-master ledger's green-reference renderer).

Runs under headless Blender and reuses the spike_tripo_render.py output
contract verbatim (yaw45 ortho camera, flat emission, Standard view
transform, transparent film — the precedent every registered master's
green reference was cast with):

    blender -b -P scripts/factory/bpy_render_loop.py -- <glb> <outdir> \
        --start-time F --span L --frames N [--yaw 45] [--resolution 720]

Argument-name caveat: the Cycles addon parses everything after `--` with
its own argparse (--cycles-print-stats/--cycles-device), and an option that
prefixes those (e.g. --cycle) aborts Cycles' registration with an
"ambiguous option" error before the engine even exists (measured
2026-08-14) — hence --span.

What is new over the spike renderer: frames are sampled at N evenly spaced
SUB-FRAME times over the true fractional cycle [start, start+cycle) via
frame_set(frame, subframe=…) — verified to evaluate interpolated poses
(2026-08-14). Meshy clips are authored at their own rate, so their cycle
length at 24fps is fractional (walking = 24.8 frames); integer-frame
stepping would bake a sub-frame seam into every tiled reference, the exact
seam shape that makes a clean-up model smear the loop unevenly
(運転知見 18). Sampling the cycle exactly closes the tile seam by
construction, at the cost of an imperceptible ≤2% speed change.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mathutils import Vector  # noqa: E402

import bpy  # noqa: E402
from factory.spike_tripo_render import (  # noqa: E402
    flatten_materials,
    load,
    setup_camera,
    setup_render,
    world_bounds,
)


def main() -> None:
    import argparse
    import math

    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb")
    parser.add_argument("outdir")
    parser.add_argument("--start-time", type=float, required=True)
    parser.add_argument("--span", type=float, required=True)
    parser.add_argument("--frames", type=int, required=True)
    parser.add_argument("--yaw", type=float, default=45)
    parser.add_argument("--resolution", type=int, default=720)
    args = parser.parse_args(argv)

    load(args.glb)
    actions = list(bpy.data.actions)
    if len(actions) != 1:
        raise SystemExit(
            f"expected exactly one action in {args.glb}, found "
            f"{[a.name for a in actions]}"
        )
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    armature.animation_data_create().action = actions[0]

    flatten_materials()
    setup_render(args.resolution)
    scene = bpy.context.scene

    def set_time(time: float) -> None:
        scene.frame_set(int(time), subframe=time - int(time))

    times = [args.start_time + i * args.span / args.frames for i in range(args.frames)]

    # Fit one camera over every sampled pose so no frame is cropped and the
    # framing is loop-stable (the spike renderer's fitting rule).
    set_time(times[0])
    setup_camera(args.yaw)
    camera = scene.camera
    lo_all = Vector((1e9, 1e9, 1e9))
    hi_all = Vector((-1e9, -1e9, -1e9))
    for time in times:
        set_time(time)
        lo, hi = world_bounds()
        lo_all = Vector(map(min, lo_all, lo))
        hi_all = Vector(map(max, hi_all, hi))
    center = (lo_all + hi_all) / 2
    size = max(hi_all.x - lo_all.x, hi_all.y - lo_all.y, hi_all.z - lo_all.z)
    yaw = math.radians(args.yaw)
    camera.data.ortho_scale = size * 1.15
    camera.location = center + Vector(
        (math.sin(yaw) * size * 4, -math.cos(yaw) * size * 4, 0)
    )

    for index, time in enumerate(times):
        set_time(time)
        scene.render.filepath = f"{args.outdir}/frame_{index:02d}_t{time:07.2f}.png"
        bpy.ops.render.render(write_still=True)
        print(f"rendered {index} @ t={time:.2f}")
    print("RENDER LOOP DONE")


if __name__ == "__main__":
    main()
