#!/usr/bin/env python3
"""Render the Tripo retarget GLB to sprite frames in headless Blender
(DP-B image-to-3D spike — pairs with spike_tripo_rig.py; bpy precedent is
spike_blender_bake.py).

Style goal: keep the hand-drawn 2D look. Materials are converted to flat
emission (base-color texture, no lighting/PBR shading), the camera is
orthographic from the sprite's canonical right-facing 3/4 angle, and the
film is transparent — the same output contract as the video lane's frames.

Subcommands (run under `blender -b -P <this file> -- <cmd> ...`):
  probe   <glb> <outdir>                  render yaw 0/45/90/135/180/225/270/315
                                          stills to pick the 3/4 camera angle
  analyze <glb> <action>                  print per-frame pose distance to
                                          frame 1 (loop-closure candidates)
  render  <glb> <action> <outdir> --yaw D --start F --end F [--frames 8]
                                          render N frames evenly over [start,end]
"""

from __future__ import annotations

import math
import sys

import bpy
from mathutils import Vector


def load(glb_path: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)


def flatten_materials() -> None:
    """Replace every material with flat emission of its base-color texture."""
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        nt = mat.node_tree
        principled = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        tex = None
        if principled is not None:
            links = principled.inputs["Base Color"].links
            if links:
                tex = links[0].from_node
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        emit = nt.nodes.new("ShaderNodeEmission")
        if tex is not None:
            nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
        nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])


def scene_meshes() -> list:
    return [o for o in bpy.data.objects if o.type == "MESH"]


def world_bounds() -> tuple[Vector, Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in scene_meshes():
        for corner in obj.evaluated_get(depsgraph).bound_box:
            v = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, v))
            hi = Vector(map(max, hi, v))
    return lo, hi


def setup_camera(yaw_degrees: float, margin: float = 1.25) -> None:
    lo, hi = world_bounds()
    center = (lo + hi) / 2
    size = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    yaw = math.radians(yaw_degrees)
    distance = size * 4
    cam_data = bpy.data.cameras.new("spritecam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size * margin
    cam = bpy.data.objects.new("spritecam", cam_data)
    cam.location = center + Vector((math.sin(yaw) * distance, -math.cos(yaw) * distance, 0))
    cam.rotation_euler = (math.radians(90), 0, yaw)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam


def setup_render(resolution: int) -> None:
    scene = bpy.context.scene
    # AgX (the 4.x default) tone-maps even emission and mutes the sprite
    # palette; Standard passes the texture colors through unchanged.
    scene.view_settings.view_transform = "Standard"
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.film_transparent = True
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"


def set_action(action_name: str) -> None:
    action = bpy.data.actions[action_name]
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    armature.animation_data_create().action = action
    scene = bpy.context.scene
    scene.frame_start = int(action.frame_range[0])
    scene.frame_end = int(action.frame_range[1])


def pose_signature(armature) -> list[float]:
    values: list[float] = []
    for pb in armature.pose.bones:
        values.extend(pb.matrix_basis.to_quaternion())
        values.extend(pb.matrix_basis.to_translation())
    return values


def probe(glb: str, outdir: str) -> None:
    load(glb)
    flatten_materials()
    setup_render(360)
    scene = bpy.context.scene
    scene.frame_set(1)
    for yaw in range(0, 360, 45):
        for existing in [o for o in bpy.data.objects if o.name.startswith("spritecam")]:
            bpy.data.objects.remove(existing)
        setup_camera(yaw)
        scene.render.filepath = f"{outdir}/probe_yaw{yaw:03d}.png"
        bpy.ops.render.render(write_still=True)
        print("probe rendered yaw", yaw)


def analyze(glb: str, action_name: str, out_path: str) -> None:
    """Dump every frame's pose signature as JSON for offline loop search."""
    import json

    load(glb)
    set_action(action_name)
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    scene = bpy.context.scene
    signatures = {}
    for frame in range(scene.frame_start, scene.frame_end + 1):
        scene.frame_set(frame)
        signatures[frame] = pose_signature(armature)
    with open(out_path, "w") as handle:
        json.dump(signatures, handle)
    print(f"SIGNATURES {len(signatures)} -> {out_path}")


def render(argv: list[str]) -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("glb")
    parser.add_argument("action")
    parser.add_argument("outdir")
    parser.add_argument("--yaw", type=float, required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--resolution", type=int, default=720)
    args = parser.parse_args(argv)

    load(args.glb)
    flatten_materials()
    set_action(args.action)
    setup_render(args.resolution)
    scene = bpy.context.scene
    # Fit the camera over the whole segment so no frame is cropped: sample
    # bounds at each output frame before creating the camera.
    frames = [
        args.start + round(i * (args.end - args.start) / args.frames)
        for i in range(args.frames)
    ]
    scene.frame_set(frames[0])
    setup_camera(args.yaw)
    camera = bpy.context.scene.camera
    lo_all = Vector((1e9, 1e9, 1e9))
    hi_all = Vector((-1e9, -1e9, -1e9))
    for frame in frames:
        scene.frame_set(frame)
        lo, hi = world_bounds()
        lo_all = Vector(map(min, lo_all, lo))
        hi_all = Vector(map(max, hi_all, hi))
    center = (lo_all + hi_all) / 2
    size = max(hi_all.x - lo_all.x, hi_all.y - lo_all.y, hi_all.z - lo_all.z)
    yaw = math.radians(args.yaw)
    camera.data.ortho_scale = size * 1.15
    camera.location = center + Vector((math.sin(yaw) * size * 4, -math.cos(yaw) * size * 4, 0))
    for index, frame in enumerate(frames):
        scene.frame_set(frame)
        scene.render.filepath = f"{args.outdir}/frame_{index:02d}_f{frame:04d}.png"
        bpy.ops.render.render(write_still=True)
        print("rendered", frame)
    print("RENDER DONE")


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if argv[:1] == ["probe"]:
        probe(argv[1], argv[2])
    elif argv[:1] == ["analyze"]:
        analyze(argv[1], argv[2], argv[3])
    elif argv[:1] == ["render"]:
        render(argv[1:])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
