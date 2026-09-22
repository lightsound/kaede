"""Type-specific prompt templates for the asset factory (asset-pipeline.md §4).

Orders may set `template` + `vars` instead of a fully written `prompt`. The
orchestrator expands the template; the committed order's `prompt` field always
records the fully expanded text (reproducibility — manifest.source.prompt).
"""

from __future__ import annotations

TEMPLATES: dict[str, str] = {
    # Stand frame on pure green, style-locked by the canonical reference image.
    "avatar-stand": (
        "A single full-body chibi {subject} game character, MapleStory-like "
        "2D side-scroller style matching the reference image exactly (same "
        "line weight, soft cel shading, cute proportions, ~3-head-tall). "
        "{appearance} Wearing {outfit}. Facing right in 3/4 view, standing "
        "idle with arms relaxed at the sides, feet together on an invisible "
        "ground line. Flat pure green #00FF00 chroma-key background, no "
        "shadow, no ground, no props, no text. Centered, character fills "
        "most of the frame vertically."
    ),
    # Exaggerated in-place walk — the ①b(c) adopted wan-2.7-i2v recipe.
    "avatar-walk-i2v": (
        "The chibi game character from the image walks in place, "
        "treadmill-style, without moving across the frame. An exaggerated "
        "cartoon game walk cycle like classic 2D side-scrolling games: BIG "
        "strides with legs swinging far forward and far back, knees lifting "
        "high on each step, and arms swinging WIDELY — the near arm swings "
        "clearly in front of the chest, then far behind the back, opposite "
        "to the legs. Legs strictly alternate. Keep facing right in 3/4 "
        "view. The camera is completely static, no zoom, no pan. The flat "
        "pure green #00FF00 chroma-key background stays perfectly unchanged "
        "and empty. The character stays centered with feet returning to the "
        "same ground line every step. The character's clothes, hair, skin "
        "and shoes keep exactly the same colors in every frame. Constant "
        "even lighting, no shadows."
    ),
    # Walk with per-order color locking ({colorNotes} from order.vars) — for
    # characters whose pale skin / pastel clothes wan repaints (measured on
    # the girl: yellow/pink limb drift on two takes with the generic prompt).
    "avatar-walk-i2v-locked": (
        "The chibi game character from the image walks in place, "
        "treadmill-style, without moving across the frame. An exaggerated "
        "cartoon game walk cycle like classic 2D side-scrolling games: BIG "
        "strides with legs swinging far forward and far back, knees lifting "
        "high on each step, and arms swinging WIDELY — the near arm swings "
        "clearly in front of the chest, then far behind the back, opposite "
        "to the legs. Legs strictly alternate. Keep facing right in 3/4 "
        "view. The camera is completely static, no zoom, no pan. The flat "
        "pure green #00FF00 chroma-key background stays perfectly unchanged "
        "and empty. The character stays centered with feet returning to the "
        "same ground line every step. {colorNotes} Flat cel colors exactly "
        "as in the input image, constant even lighting, no shadows, no "
        "darkening of any body part or garment in any frame."
    ),
    # Walk with the arm SWAP spelled out per step ({colorNotes} as above).
    # The generic prompt let wan keep one arm forward through the whole
    # stride on the girl (owner reject 2026-08-09: 手が交差していない);
    # naming the swap on every step is what fixes it.
    "avatar-walk-i2v-arms": (
        "The chibi game character from the image walks in place, "
        "treadmill-style, without moving across the frame. An exaggerated "
        "cartoon game walk cycle like classic 2D side-scrolling games: BIG "
        "strides with legs swinging far forward and far back, knees lifting "
        "high on each step — legs STRICTLY ALTERNATE, first one leg strides "
        "fully forward, then the other. The arms swing WIDELY in opposition "
        "to the legs and MUST TRADE PLACES on every step: the near arm "
        "swings clearly in front of the chest, then far behind the back on "
        "the next step, while the far arm does the opposite. Never let the "
        "same arm stay in front for two steps. NO MOTION BLUR — crisp "
        "clean line art on the arms and legs in every frame. Keep facing "
        "right in 3/4 view. The camera "
        "is completely static, no zoom, no pan. The flat pure green "
        "#00FF00 chroma-key background stays perfectly unchanged and "
        "empty. The character stays centered with feet returning to the "
        "same ground line every step. {colorNotes} Flat cel colors exactly "
        "as in the input image, constant even lighting, no shadows, no "
        "darkening of any body part or garment in any frame."
    ),
    # The softened arm-swap variant: empirically the best leg-alternation
    # odds on the pale-legged girl (the adopted take-5 clip alternated with
    # this wording; the marching-style exaggerated wording shuffles more
    # often on her). Same {colorNotes} contract.
    "avatar-walk-i2v-arms-soft": (
        "The chibi game character from the image walks in place, "
        "treadmill-style, without moving across the frame. An exaggerated "
        "cartoon game walk cycle like classic 2D side-scrolling games. The "
        "arms swing naturally front and back in opposition to the legs and "
        "MUST TRADE PLACES on every step: when the near leg strides "
        "forward, the near arm swings behind the back while the far arm "
        "comes forward; on the very next step they SWAP — the near arm "
        "comes forward in front of the body and the far arm goes behind. "
        "Never let the same arm stay in front for two steps. Relaxed "
        "elbows, no flailing, NO MOTION BLUR — crisp clean line art on "
        "the arms and legs in every frame. BIG strides, knees lifting "
        "high, legs strictly alternating. Keep facing right in 3/4 view. "
        "The camera is completely static, no zoom, no pan. The flat pure "
        "green #00FF00 chroma-key background stays perfectly unchanged "
        "and empty. The character stays centered with feet returning to "
        "the same ground line every step. {colorNotes} Flat cel colors "
        "exactly as in the input image, constant even lighting, no "
        "shadows, no darkening of any body part or garment in any frame."
    ),
    # Carry stand: near-arm mitten at waist (①b(a)⑵ owner spec).
    "avatar-carry-stand": (
        "Edit ONLY the arms of this chibi game character on the pure green "
        "background. The NEAR arm — shoulder, upper arm and elbow FULLY "
        "VISIBLE drawn in front of the torso — bent at the elbow, forearm "
        "forward and slightly downward, the hand a SIMPLE ROUND MITTEN with "
        "NO fingers held in front of the WAIST (not chest — tall items must "
        "not cover the face). The far arm hangs straight down behind the "
        "torso. Keep everything else EXACTLY pixel-identical: face, hair, "
        "outfit, legs, shoes, pose of the body, green background."
    ),
    # Carry walk: legs move, arms stay (wan obeys still-arm prompts).
    "avatar-carry-walk-i2v": (
        "The chibi game character from the image walks in place, "
        "treadmill-style, without moving across the frame. BIG exaggerated "
        "cartoon strides with legs swinging far forward and far back, knees "
        "lifting high, legs strictly alternating. The near arm stays "
        "PERFECTLY STILL exactly as in the image — bent at the elbow with "
        "the round mitten hand held in front of the waist. The far arm also "
        "stays still, hanging at the side behind the body. Only the legs "
        "move. Keep facing right in 3/4 view. Static camera, flat pure "
        "green #00FF00 background unchanged and empty, no shadows."
    ),
    # Outfit-only sheet edit (nano-banana keep-everything). Frame-count
    # agnostic since the A-3 densification (sheets carry 4 or 12 walk
    # cells) — and NOTE: the whole-sheet edit collapsed on a host-side
    # nano-banana-2 behavior change (運転知見 40); production outfits use
    # the per-cell recipe (知見 41), which records its own prompts.
    "avatar-outfit-edit": (
        "This image is a sprite sheet of frames of the same chibi game "
        "character on a flat pure green #00FF00 chroma-key background: "
        "standing, then a walk cycle. Edit ONLY the clothes: {outfit}. "
        "Keep everything else EXACTLY pixel-identical in every frame: the "
        "same face, eyes, hair, skin, shoes, body poses, arm and leg "
        "positions, frame layout, and green background."
    ),
}


def expand(template_name: str, vars: dict[str, str]) -> str:
    """Expand a named template. Unknown keys in the template raise KeyError."""
    try:
        body = TEMPLATES[template_name]
    except KeyError as exc:
        known = ", ".join(sorted(TEMPLATES))
        raise SystemExit(f"unknown template {template_name!r} (known: {known})") from exc
    try:
        return body.format_map(vars)
    except KeyError as exc:
        raise SystemExit(
            f"template {template_name!r} missing var {exc.args[0]!r}; have {sorted(vars)}"
        ) from exc
