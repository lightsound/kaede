#!/usr/bin/env python3
"""DP-B showdown spike: rig the chibi character in headless Blender and bake
a dance loop to frames (avatar-rig.md §6 DP-B, run 2026-08-10 in Phase 5 ①c).

Kept as the experiment's reproduction tool (the spike-realtimekit.sh
precedent): if DP-B is ever re-evaluated, this is the exact cutout-rig
pipeline that produced the bake-lane entry of the showdown. Not part of the
production factory line.

Two stages, both headless:

  cut   — segment one A-pose frame into 6 part PNGs (head, torso, 2 arms,
          2 legs) with duplicated joint discs so bone rotation does not open
          gaps. Joint coordinates were measured on the bench A-pose
          (R2 original 1d124fc00afd1f2c3105b4d33c24c701e7abe55e890efd347e9f0673774199e1,
          418x660 after chroma-key + crop) and are hardcoded — a different
          character needs them re-measured (that per-character cost is part
          of the showdown's findings).
  bake  — build an armature (root/torso/head/arm.L/arm.R/leg.L/leg.R),
          bone-parent the part planes, keyframe a 24-frame dance loop from
          closed-form curves (loop closes by construction) and render 8
          frames (100ms cells, the video lane's format) with Cycles
          1-sample emission.

Usage:
    python3 scripts/factory/spike_blender_bake.py cut  <apose_keyed.png> <workdir>
    blender -b -P scripts/factory/spike_blender_bake.py -- bake <workdir>

Findings (2026-08-10 run, judged against the video lane's dance):
- Mechanically the lane works end to end; the loop closes perfectly and
  colors/head are pixel-stable (no AI morphing) — the bake lane's structural
  strengths, confirmed.
- Visually it was judged "rigid paper puppet": a single-piece arm rotated
  overhead keeps its downward-drawn sleeve and has no elbow — rotation
  creates no new pixels, exactly the weakness avatar-rig.md §6 predicted.
  Fixing it means elbow bones + per-part redraws, i.e. the aesthetic manual
  work the lane was supposed to avoid.
- Agent cost: 1 A-pose still ($0.10) + ~60 min (part cuts, one axis
  calibration render, three bake iterations) vs the video lane's $0.50 +
  ~50 min single take.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

# ---------------------------------------------------------------- geometry
# Measured on the bench A-pose (see module docstring).
NECK = (211, 336)
CHIN = 14
SH_L = (152, 398)
SH_R = (288, 412)
HIP_Y = 518
CROTCH_X = 212
HIP_L = (172, 524)
HIP_R = (248, 524)
JOINT_R = 16
IMG_H = 660
CX = 211

BONES = {
    "root": ((CX, 470), None),
    "torso": ((CX, 470), "root"),
    "head": (NECK, "torso"),
    "arm_l": (SH_L, "torso"),
    "arm_r": (SH_R, "torso"),
    "leg_l": (HIP_L, "root"),
    "leg_r": (HIP_R, "root"),
}
# Camera looks along +Y; smaller y = closer. Head over the near arm so an
# overhead swing passes behind the face (take-2 fix).
DEPTH = {"head": -0.05, "arm_r": -0.04, "leg_r": -0.03, "torso": -0.02, "leg_l": -0.01, "arm_l": 0.0}
S = 0.01  # blender units per source px
FRAMES = 24
RENDER_EVERY = 3


def cut(apose_path: Path, work: Path) -> None:
    """Segment the keyed A-pose into part PNGs + parts_meta.json."""
    import numpy as np
    from PIL import Image

    img = Image.open(apose_path).convert("RGBA")
    a = np.asarray(img).copy()
    op = a[:, :, 3] > 128
    h, w = op.shape
    yy, xx = np.mgrid[0:h, 0:w]

    def disc(c, r=JOINT_R):
        return (xx - c[0]) ** 2 + (yy - c[1]) ** 2 <= r * r

    head_m = op & (yy <= NECK[1] + CHIN)
    arm_l_m = op & (xx <= 155) & (yy >= 385) & (yy <= 515) & ~head_m
    arm_r_m = op & (xx >= 283) & (yy >= 398) & (yy <= 505) & ~head_m
    leg_l_m = op & (yy >= HIP_Y) & (xx < CROTCH_X)
    leg_r_m = op & (yy >= HIP_Y) & (xx >= CROTCH_X)
    # Torso keeps the joint discs and a 12px crotch band (duplicated pixels
    # cover the joints when a limb rotates away).
    torso_m = (
        op
        & (yy > NECK[1])
        & ~(arm_l_m & ~disc(SH_L))
        & ~(arm_r_m & ~disc(SH_R))
        & ~(leg_l_m & ~disc(HIP_L) & (yy > HIP_Y + 12))
        & ~(leg_r_m & ~disc(HIP_R) & (yy > HIP_Y + 12))
    )
    parts = {
        "head": (head_m, NECK),
        "torso": (torso_m, BONES["torso"][0]),
        "arm_l": (arm_l_m, SH_L),
        "arm_r": (arm_r_m, SH_R),
        "leg_l": (leg_l_m, HIP_L),
        "leg_r": (leg_r_m, HIP_R),
    }
    meta = {}
    work.mkdir(parents=True, exist_ok=True)
    for name, (m, pivot) in parts.items():
        ys, xs = np.where(m)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        part = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        sel = m[y0:y1, x0:x1]
        part[sel] = a[y0:y1, x0:x1][sel]
        Image.fromarray(part, "RGBA").save(work / f"part_{name}.png")
        meta[name] = {"bbox": [int(x0), int(y0), int(x1), int(y1)], "pivot": list(pivot)}
    (work / "parts_meta.json").write_text(json.dumps(meta, indent=1))
    print("cut done:", ", ".join(parts))


# ---------------------------------------------------------------- bake
def to_world(px: float, py: float) -> tuple[float, float]:
    return ((px - CX) * S, (IMG_H - py) * S)


def pose_at(t: float) -> dict:
    """Bone -> (pose location | None, local-Z rotation in degrees).

    Calibrated axes (one test render): pose location local X = screen
    right, local Y = screen up; positive local-Z rotation = CCW on screen.
    Rest = A-pose (arms 45° down); the near arm goes overhead with positive
    rotation, the far arm with negative, half a cycle apart.
    """
    w = 2 * math.pi * t
    return {
        "root": ((0.12 * math.sin(w), 0.09 * abs(math.sin(w)), 0), 0),
        "torso": (None, 4 * math.sin(w)),
        "head": (None, -5 * math.sin(w)),
        "arm_r": (None, 55 + 50 * math.sin(w)),
        "arm_l": (None, -(55 + 50 * math.sin(w + math.pi))),
        "leg_l": (None, 9 * math.sin(2 * w)),
        "leg_r": (None, -9 * math.sin(2 * w)),
    }


def bake(work: Path) -> None:
    import bpy
    import mathutils

    meta = json.loads((work / "parts_meta.json").read_text())

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.film_transparent = True
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.frame_start, scene.frame_end = 1, FRAMES

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 7.2
    cam = bpy.data.objects.new("cam", cam_data)
    cam.location = (0, -10, 3.0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.collection.objects.link(cam)
    scene.camera = cam

    arm_data = bpy.data.armatures.new("rig")
    rig = bpy.data.objects.new("rig", arm_data)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = {}
    for name, (pivot, _parent) in BONES.items():
        b = arm_data.edit_bones.new(name)
        x, z = to_world(*pivot)
        b.head, b.tail, b.roll = (x, 0, z), (x, 0, z + 0.4), 0
        edit_bones[name] = b
    for name, (_pivot, parent) in BONES.items():
        if parent:
            edit_bones[name].parent = edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")

    def make_material(name: str, img_path: Path):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        mix = nt.nodes.new("ShaderNodeMixShader")
        transp = nt.nodes.new("ShaderNodeBsdfTransparent")
        emit = nt.nodes.new("ShaderNodeEmission")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(img_path))
        tex.interpolation = "Closest"
        nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
        nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
        nt.links.new(transp.outputs["BSDF"], mix.inputs[1])
        nt.links.new(emit.outputs["Emission"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        return mat

    for name, m in meta.items():
        x0, y0, x1, y1 = m["bbox"]
        xa, za = to_world(x0, y1)
        xb, zb = to_world(x1, y0)
        y = DEPTH[name]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(
            [(xa, y, za), (xb, y, za), (xb, y, zb), (xa, y, zb)], [], [(0, 1, 2, 3)]
        )
        uvl = mesh.uv_layers.new()
        for i, uv in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
            uvl.data[i].uv = uv
        obj = bpy.data.objects.new(name, mesh)
        obj.data.materials.append(make_material(name, work / f"part_{name}.png"))
        scene.collection.objects.link(obj)
        # Bone parenting pivots at the bone TAIL. The parent-inverse is
        # computed from the REST matrix (data.bones.matrix_local): in
        # background mode pose.bones[..].matrix is identity until a
        # depsgraph evaluation, which silently yields an identity inverse
        # and lays every plane flat (take-1 bug).
        obj.parent = rig
        obj.parent_type = "BONE"
        obj.parent_bone = name
        bone = rig.data.bones[name]
        channel = bone.matrix_local @ mathutils.Matrix.Translation((0, bone.length, 0))
        obj.matrix_parent_inverse = (rig.matrix_world @ channel).inverted()

    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
    for f in range(1, FRAMES + 1):
        t = (f - 1) / FRAMES
        scene.frame_set(f)
        for name, (loc, rz) in pose_at(t).items():
            pb = rig.pose.bones[name]
            if loc is not None:
                pb.location = loc
                pb.keyframe_insert("location", frame=f)
            pb.rotation_euler = (0, 0, math.radians(rz))
            pb.keyframe_insert("rotation_euler", frame=f)

    out_dir = work / "bake_frames"
    out_dir.mkdir(exist_ok=True)
    for f in range(1, FRAMES + 1, RENDER_EVERY):
        scene.frame_set(f)
        scene.render.filepath = str(out_dir / f"bake_{f:04d}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", f)
    print("BAKE DONE")


def main() -> None:
    # Under `blender -b -P script -- bake <work>` our args follow the `--`.
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if argv[:1] == ["cut"]:
        cut(Path(argv[1]), Path(argv[2]))
    elif argv[:1] == ["bake"]:
        bake(Path(argv[1]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
