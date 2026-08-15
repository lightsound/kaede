"""3rd-layer arm-mask helpers (factory v2 手順 3 — §2.1 of
docs/factory-v2-plan.md).

The pieces that turn bpy_render_arm_ids.py output (per-loop-phase ARM-ID
renders + bones.json joint projections) into shipped arm layers:

- sample_index / near_side: map a master frame to its ID render and decide
  which arm chain is the NEAR one (camera depth of the hand bones — never
  pixel anatomy, the 差し戻し⑤ heuristic this step retires).
- arm_companion / arm_masks_of: read the flat ID colors (red = left chain,
  blue = right chain) as boolean masks, NEAREST-scaled so the colors stay
  classifiable.
- apply_map: replay the compose lane's crop/scale/pad chain on a point, so
  bone projections land in sheet-cell coordinates (the machine source for
  hand anchors).
- split_arm_layers: the actual layer separation — an EXACT partition of one
  imported frame into armless body / far arm / near arm, so compositing
  body → far → item → near reconstructs the frame byte-identically when
  nothing is held.
"""

from __future__ import annotations

import numpy as np
from PIL import Image
from scipy import ndimage


def sample_index(frame_index: int, source_start: int, samples: int) -> int:
    """The ID-render phase of master frame `frame_index` (0-based).

    A recast master is frame-synced 1:1 to its 3D green reference (replace
    inherits timing) and trimmed at register_take's sourceStart, so master
    frame i shows reference frame (sourceStart + i); the reference tiles the
    `samples`-frame loop window, hence the modulo.
    """
    return (source_start + frame_index) % samples


def near_side(sample: dict) -> str:
    """'left' | 'right' — the hand chain nearer the camera.

    bones.json records each hand bone's camera depth (world_to_camera_view
    z); the smaller depth is the near arm. Decided per frame from geometry,
    replacing the handLayerSide order field an operator used to eyeball.
    """
    return "left" if sample["LeftHand"][2] < sample["RightHand"][2] else "right"


def arm_masks_of(mask_img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """(left, right) boolean masks of an ARM-ID image's flat chain colors.

    Thresholds sit far from both flat ID colors (255,0,0)/(0,0,255) and the
    body white, so NEAREST rescaling artifacts cannot flip a class.
    """
    a = np.asarray(mask_img.convert("RGBA")).astype(int)
    visible = a[..., 3] > 128
    left = visible & (a[..., 0] > 150) & (a[..., 1] < 100) & (a[..., 2] < 100)
    right = visible & (a[..., 2] > 150) & (a[..., 0] < 100) & (a[..., 1] < 100)
    return left, right


def arm_companion(ids_img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """The ARM pixels of one ID render, as an RGBA companion at `size`.

    Body-white (and everything else) goes transparent so the companion can
    ride the compose lane's transparent-canvas transform chain; NEAREST
    keeps red/blue classifiable after the master-resolution upscale.
    """
    scaled = ids_img.convert("RGBA").resize(size, Image.NEAREST)
    left, right = arm_masks_of(scaled)
    out = np.asarray(scaled).copy()
    out[~(left | right)] = 0
    return Image.fromarray(out)


def apply_map(transform: dict, point: tuple[float, float]) -> list[int]:
    """A source-frame point through the compose lane's recorded transform.

    `transform` is compose_walk_sheet's layer_sink map: {"crop1": [x0, y0,
    x1, y1], "scale": [sx, sy], "shift": [dx, dy]} — the content trim, the
    cycle-wide resize, and the pad/re-trim/cell-placement translations
    folded into one shift.
    """
    return [
        round((point[0] - transform["crop1"][0]) * transform["scale"][0] + transform["shift"][0]),
        round((point[1] - transform["crop1"][1]) * transform["scale"][1] + transform["shift"][1]),
    ]


def split_arm_layers(
    frame: Image.Image,
    mask: Image.Image,
    near: str,
    dilate_px: int = 2,
) -> tuple[Image.Image, tuple[Image.Image, list[int]], tuple[Image.Image, list[int]]]:
    """Partition one frame into (armless body, (far, offset), (near, offset)).

    EXACT partition: every content pixel lands in exactly one output, so
    compositing body → far → near reconstructs the frame byte-identically —
    the held item slides between far and near without any seam risk. The
    dilation absorbs the clean-up model's overdraw past the 3D mask edge
    (measured ≲2px at the master's 960px scale, sub-pixel at 192px
    shipping); the near mask wins where the dilated masks overlap, because
    the nearer surface must stay in front of the item. Offsets are the
    layer's top-left in frame pixels.
    """
    rgba = np.asarray(frame.convert("RGBA"))
    content = rgba[..., 3] > 0
    left, right = arm_masks_of(mask)
    near_raw, far_raw = (left, right) if near == "left" else (right, left)
    near_mask = ndimage.binary_dilation(near_raw, iterations=dilate_px) & content
    far_mask = ndimage.binary_dilation(far_raw, iterations=dilate_px) & content & ~near_mask
    if not near_mask.any() or not far_mask.any():
        raise SystemExit(
            "arm layer is empty — the mask sheet does not cover this frame's "
            "arms (mask/frame misregistered?)"
        )
    body = rgba.copy()
    body[near_mask | far_mask] = 0

    def cut(mask_arr: np.ndarray) -> tuple[Image.Image, list[int]]:
        ys, xs = np.nonzero(mask_arr)
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        out = np.zeros((y1 - y0, x1 - x0, 4), dtype=rgba.dtype)
        window = mask_arr[y0:y1, x0:x1]
        out[window] = rgba[y0:y1, x0:x1][window]
        return Image.fromarray(out), [x0, y0]

    return Image.fromarray(body), cut(far_mask), cut(near_mask)
