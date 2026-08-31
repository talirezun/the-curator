#!/usr/bin/env python3
"""
rebuild-app-icon.py — rebuild images/applet.icns from the design-system brand
assets, with a real alpha channel on every entry.

── WHY THIS EXISTS ───────────────────────────────────────────────────────────

The shipping icns had every large PNG entry (128/256/512/1024, both the 1x
and 2x forms) encoded as PNG colour type 2 (RGB, NO alpha channel). The area
outside the tile's rounded corners was therefore opaque WHITE rather than
transparent, so macOS composited a white square behind the icon everywhere
it is shown (Spotlight, Finder, the Dock). Verified with:

    iconutil -c iconset images/applet.icns -o /tmp/x.iconset
    xxd -p -s 25 -l 1 <png>     # byte 25 of a PNG is the IHDR colour-type byte
                                 # 6 = RGBA (correct), 2 = RGB (the bug)

── WHERE THE SOURCE ASSETS COME FROM ─────────────────────────────────────────

The design-system brand bundle ships the "dark" app-icon tile pre-composited
with the mark at 128/256/512/1024 (all confirmed colour-type 6, corners fully
transparent), plus the mark ALONE (no tile) at a "coarse cut" — a heavier
stroke width tuned for small sizes — at 16/32/48/64. There is no pre-composited
tile+coarse-mark asset at those small sizes, so this script builds one: it
renders the tile's rounded-square gradient background procedurally (from the
brand SVG's own geometry — a linear gradient inside a rounded rect, plus a
faint border stroke) and alpha-composites the coarse mark on top, matching the
exact placement transform the brand app-icon SVG uses for the mark (translate
13,13 scale 1.02 in a 128-unit viewBox).

Per the project's own measured rule (CLAUDE.md v3.25.0): the coarse cut
(stroke-width 1.9) is used for every icns entry that renders at 48 PHYSICAL
pixels or below — reasoning in physical pixels, because icon_16x16@2x is 32
physical px and icon_32x32@2x is 64 physical px. So:

    16, 32   physical px  → composited here: tile (rendered) + coarse mark
    64       physical px  → the fine composite, downsampled from the brand's
                             1024 tile+mark (64 > 48, so the coarse cut does
                             NOT apply — this is a straight high-quality
                             downsample, not a re-composite)
    128..1024 physical px → the brand's own pre-composited PNG for that size

All resizing goes through premultiplied alpha (see `resize_rgba`), because a
naive resize of straight (non-premultiplied) RGBA blends the fully-transparent
canvas colour into edge pixels near the rounded corners and produces a visible
dark halo.

── THE APPLE ICON GRID (why the tile does NOT fill the canvas) ────────────────

The brand's app-icon PNGs are drawn FULL BLEED: the rounded tile touches all
four edges of its square canvas with no transparent margin. That is correct for
a web favicon and for iOS (where the system applies its own mask), and wrong
for a macOS .app icon: Apple's grid insets the rounded-rect body inside a
transparent margin, and an icon that fills its canvas therefore renders visibly
LARGER than every neighbouring app in the Dock, Finder and Launchpad. That is
the "wide background" defect this section fixes.

The margins below were MEASURED on this machine, not taken from a spec — the
alpha>50% bounding box of real macOS application icons, which are the ground
truth for what a conforming icon looks like:

    physical px   margin   body   body/canvas
        16          1       14      87.50%
        32          2       28      87.50%
        64          6       52      81.25%
       128         12      104      81.25%
       256         25      206      80.47%
       512         50      412      80.47%
      1024        100      824      80.47%

Sources, all agreeing: GarageBand.app ships Apple's own COMPLETE ten-entry
ladder and produced every row above exactly. Notes / Mail / Maps / Reminders /
Finder / Podcasts / System Settings corroborate the rows they carry (all seven
give 25/206/25 at 256 and 12/104/12 at 128). Brave Browser reproduces the whole
ladder identically; Audacity, Camtasia, Claude and Discord all land on
100/824/100 at 1024. Discord alone deviates at the two smallest sizes (2/12/2
at 16, 3/26/3 at 32), so it is treated as a third-party variant, not ground
truth.

Note the ladder is deliberately NOT a constant ratio. Apple relaxes the margin
at 16 and 32 physical px (87.5% body instead of 80.47%), because a strict
9.77% margin would spend 3 of 32 pixels on empty space. That is the same
legibility instinct as this project's own coarse-cut rule at ≤48 physical px,
arrived at independently.

CORNER SHAPE — a KNOWN, DELIBERATE DIVERGENCE, recorded so a later audit does
not "fix" it backwards. Apple's mask is a continuous-curvature squircle. Fitted
against the measured corner profile of clean 1024 tiles, its circular-arc
equivalent radius is ~185px on the 824 body (Claude.app 185.0, Discord 185.8 —
matching the widely-quoted 185.4), while a true superellipse fits far better
(exponent ~2.4–2.5, RMS error 7.6px vs 30.8px for a circle). The brand tile is
a plain circular-arc rounded rect: the brand SVG says radius 30 in a 128-unit
viewBox, and a fit of the brand's own 1024 PNG returns 23.30% — confirming the
transcription in TILE_RADIUS below.

This script SCALES the brand tile into the body rather than re-rendering the
tile shape as an Apple squircle. Consequences, stated rather than implied:

  * Radius. Scaling preserves the ratio, so the corner radius becomes
    23.44% x 824 = 193px where Apple's circular equivalent is ~185px — about
    8px at 1024, 2px at 256, 0.25px at 32. Below the perceptual threshold at
    every size the icon is actually shown.
  * Shape class. The circular arc still differs from the squircle by up to
    ~30px at 1024 near where the corner meets the straight edge. Visible if
    compared side by side at 512; invisible at Dock sizes.

Scaling was chosen because the corner geometry is a BRAND decision recorded in
the design system's own app-icon SVG, and replacing it with a procedural Apple
squircle would (a) change artwork this script is only supposed to place, and
(b) desynchronise the four large entries (brand PNGs) from the two small ones
(rendered here from the same transcribed geometry). Adopting Apple's squircle
is a design call for the maintainer, not a side effect of a margin fix.

── USAGE ──────────────────────────────────────────────────────────────────────

    python3 scripts/rebuild-app-icon.py --brand-dir /path/to/brand_assets \
        --out images/applet.icns

`--brand-dir` (or the CURATOR_BRAND_ASSETS_DIR env var) must point at the
design-system brand bundle's root — the folder containing `png/app-icon/` and
`png/icon/`. There is deliberately NO default: the real path is the
maintainer's personal filesystem layout and must never be hardcoded into a
script in this public repository.

Requires Pillow and NumPy (`pip install pillow numpy`) — a one-off local dev
dependency for rebuilding a brand asset, never installed by `npm install` and
never shipped to a user.
"""

import argparse
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw
import numpy as np

# The ten filenames iconutil expects inside a .iconset, and the physical pixel
# size each one renders at (never the "nominal" 1x point size — @2x entries
# are what actually gets composited at that many real pixels).
ICONSET_ENTRIES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

# Per v3.25.0's measured rule: coarse cut at 48 physical px or below.
COARSE_CUTOFF_PX = 48

# Apple's macOS app-icon grid: transparent margin, in physical pixels, around
# the rounded-rect body, keyed by the entry's physical pixel size. MEASURED off
# real system application icons on macOS — see "THE APPLE ICON GRID" above for
# the sources and for why this is not a constant ratio. Every entry in
# ICONSET_ENTRIES must have a key here; build_iconset() asserts that.
ICON_GRID_MARGIN_PX = {
    16: 1,
    32: 2,
    64: 6,
    128: 12,
    256: 25,
    512: 50,
    1024: 100,
}


def grid_body_px(canvas_px):
    """The rounded-tile body size for a canvas of `canvas_px` physical pixels."""
    try:
        margin = ICON_GRID_MARGIN_PX[canvas_px]
    except KeyError:
        raise SystemExit(f"no measured Apple-grid margin for a {canvas_px}px entry")
    return canvas_px - 2 * margin, margin

# The brand app-icon SVG's tile geometry (128-unit viewBox), transcribed from
# svg/app-icon/curator-app-icon.svg so this script never needs an SVG
# rasterizer as a dependency.
TILE_VIEWBOX = 128
TILE_RADIUS = 30
TILE_GRADIENT_FROM = (0x1C, 0x12, 0x35)   # stop offset 0
TILE_GRADIENT_TO = (0x0B, 0x0B, 0x12)      # stop offset 1
TILE_GRADIENT_VEC = (0.3, 1.0)             # objectBoundingBox x1,y1=0,0 -> x2,y2
BORDER_INSET = 1
BORDER_RADIUS = 29
BORDER_COLOR = (157, 128, 248)
BORDER_ALPHA = 0.32
BORDER_WIDTH = 1

# The mark's placement inside the tile: <g transform="translate(13 13) scale(1.02)">
# around a mark drawn in a 0..100 local coordinate space.
MARK_TRANSLATE = 13
MARK_SCALE = 1.02
MARK_LOCAL_SIZE = 100

SUPERSAMPLE = 8


def premultiply(img):
    """RGBA -> (premultiplied RGB float array, straight alpha float array), both 0..255."""
    arr = np.asarray(img.convert("RGBA")).astype(np.float32)
    rgb, a = arr[..., :3], arr[..., 3]
    return rgb * (a[..., None] / 255.0), a


def unpremultiply_to_image(premult_rgb, alpha):
    """Inverse of premultiply(); alpha=0 pixels get RGB 0 (fully transparent, value irrelevant)."""
    safe_a = np.where(alpha == 0, 1.0, alpha)
    rgb = np.clip(premult_rgb / (safe_a[..., None] / 255.0), 0, 255)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def resize_rgba(img, size):
    """High-quality RGBA resize via premultiplied alpha (no dark-halo fringing
    at transparent/opaque boundaries, which a naive RGBA resize produces)."""
    premult_rgb, alpha = premultiply(img)
    premult_img = Image.fromarray(premult_rgb.astype(np.uint8), "RGB")
    alpha_img = Image.fromarray(alpha.astype(np.uint8), "L")
    premult_resized = np.asarray(premult_img.resize(size, Image.LANCZOS)).astype(np.float32)
    alpha_resized = np.asarray(alpha_img.resize(size, Image.LANCZOS)).astype(np.float32)
    return unpremultiply_to_image(premult_resized, alpha_resized)


def place_on_grid(art, canvas_px):
    """Scale the full-bleed tile artwork `art` down to the Apple-grid body size
    for `canvas_px` and centre it on a FULLY TRANSPARENT canvas_px square.

    This is the whole margin fix. `art` is the brand tile drawn edge to edge;
    the returned image is that tile occupying only the body, with a transparent
    macOS-conforming margin around it. The margin is symmetric by construction
    (body = canvas - 2*margin), so the tile is exactly centred and no rounding
    can push it off-centre by half a pixel.
    """
    body, margin = grid_body_px(canvas_px)
    if art.size != (body, body):
        art = resize_rgba(art, (body, body))
    canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    canvas.alpha_composite(art, (margin, margin))
    return canvas


def render_tile(px_size, supersample=SUPERSAMPLE):
    """The rounded-square gradient tile background alone, at px_size, RGBA,
    alpha=0 outside the rounded rect. Rendered supersampled then downsampled
    (premultiplied) for anti-aliasing. Not used by build_iconset() directly —
    composite_coarse() calls _render_tile_at() so the mark it pastes on top
    shares ONE final downsample with the tile, rather than two sequential
    downsamples softening the mark twice. Kept as a standalone entry point for
    inspecting the bare tile.
    """
    S = px_size * supersample
    return resize_rgba(_render_tile_at(S), (px_size, px_size))


def composite_coarse(body_px, mark_source_path, supersample=SUPERSAMPLE):
    """Tile (rendered) + the coarse mark, placed exactly where the brand
    app-icon SVG places the fine mark (translate 13,13 scale 1.02 of a 128-unit
    tile) so a small icns entry keeps the same proportions as the large ones.

    `body_px` is the BODY size (the rounded tile itself), not the canvas size —
    the caller pads this out to the canvas with `place_on_grid`. Rendering
    straight to the body means the tile geometry, the mark placement and the
    Apple margin all stay proportional at the small sizes, exactly as they do
    at the large ones where the brand PNG is simply scaled into the body.
    """
    S = body_px * supersample
    scale = S / TILE_VIEWBOX

    # Render tile directly at supersampled resolution so mark + tile share one
    # final downsample (two sequential downsamples would soften the mark twice).
    tile_S = _render_tile_at(S)

    mark_size_px = MARK_LOCAL_SIZE * MARK_SCALE * scale
    offset_px = MARK_TRANSLATE * scale

    mark_src = Image.open(mark_source_path).convert("RGBA")
    mark_resized = resize_rgba(mark_src, (round(mark_size_px), round(mark_size_px)))

    composite = tile_S.copy()
    composite.alpha_composite(mark_resized, (round(offset_px), round(offset_px)))

    return resize_rgba(composite, (body_px, body_px))


def _render_tile_at(S):
    """Same geometry as render_tile(), but already at the final supersampled
    pixel size S (no internal downsample) — used when the caller will
    downsample once, later, together with a mark composited on top."""
    scale = S / TILE_VIEWBOX
    gx, gy = TILE_GRADIENT_VEC
    denom = gx * gx + gy * gy
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u = xx / max(S - 1, 1)
    v = yy / max(S - 1, 1)
    t = np.clip((u * gx + v * gy) / denom, 0.0, 1.0)
    c1 = np.array(TILE_GRADIENT_FROM, dtype=np.float32)
    c2 = np.array(TILE_GRADIENT_TO, dtype=np.float32)
    grad = (c1[None, None, :] + (c2 - c1)[None, None, :] * t[..., None]).astype(np.uint8)
    grad_img = Image.fromarray(grad, "RGB")

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=TILE_RADIUS * scale, fill=255
    )
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tile.paste(grad_img, (0, 0), mask)

    border_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    inset = BORDER_INSET * scale
    ImageDraw.Draw(border_layer).rounded_rectangle(
        [inset, inset, S - 1 - inset, S - 1 - inset],
        radius=BORDER_RADIUS * scale,
        outline=(*BORDER_COLOR, round(255 * BORDER_ALPHA)),
        width=max(1, round(BORDER_WIDTH * scale)),
    )
    return Image.alpha_composite(tile, border_layer)


def build_iconset(brand_dir, out_dir):
    app_icon_dir = os.path.join(brand_dir, "png", "app-icon")
    icon_dir = os.path.join(brand_dir, "png", "icon")

    def brand_app_icon(size):
        p = os.path.join(app_icon_dir, f"curator-app-icon-dark-{size}.png")
        if not os.path.exists(p):
            raise SystemExit(f"missing brand asset: {p}")
        return p

    def brand_coarse_mark(size):
        p = os.path.join(icon_dir, f"curator-icon-on-dark-{size}.png")
        if not os.path.exists(p):
            raise SystemExit(f"missing brand asset: {p}")
        return p

    # Highest-resolution fine composite, used as the downsample source for the
    # 64px entry (above the 48px coarse-cut threshold).
    largest_fine = Image.open(brand_app_icon(1024)).convert("RGBA")
    # Highest-resolution coarse mark, used as the composite source for 16/32.
    largest_coarse_mark = brand_coarse_mark(1024)

    written = {}
    for name, px in ICONSET_ENTRIES:
        body, margin = grid_body_px(px)

        if px in (128, 256, 512, 1024):
            # The brand's own pre-composited tile for this size, SCALED into the
            # Apple-grid body. It is full bleed on disk; place_on_grid is what
            # gives it the transparent macOS margin.
            art = Image.open(brand_app_icon(px)).convert("RGBA")
            if art.size != (px, px):
                raise SystemExit(f"{brand_app_icon(px)} is {art.size}, expected {(px, px)}")
            img = place_on_grid(art, px)
        elif px == 64:
            # Fine cut, downsampled — 64 physical px is ABOVE the 48px coarse
            # threshold, so this is a plain high-quality downsample, not a
            # re-composite with the coarse mark. Downsampled straight from the
            # 1024 master to the 52px body in one step.
            img = place_on_grid(largest_fine, px)
        elif px in (16, 32):
            assert px <= COARSE_CUTOFF_PX
            # Composited at the BODY size (14 / 28), then padded to the canvas.
            img = place_on_grid(composite_coarse(body, largest_coarse_mark), px)
        else:
            raise SystemExit(f"unexpected iconset size {px}")

        # Self-check: the entry must be the right size, must carry alpha, and
        # the margin ring must be FULLY transparent. A regression to full bleed
        # — the defect this grid exists to fix — fails here rather than shipping.
        if img.size != (px, px):
            raise SystemExit(f"{name}: built {img.size}, expected {(px, px)}")
        if img.mode != "RGBA":
            raise SystemExit(f"{name}: mode {img.mode}, expected RGBA")
        alpha = np.asarray(img)[..., 3]
        ring = alpha.copy()
        ring[margin:px - margin, margin:px - margin] = 0
        if ring.max() != 0:
            raise SystemExit(
                f"{name}: content encroaches into the {margin}px Apple-grid margin "
                f"(max alpha {int(ring.max())} in the margin ring)"
            )
        if alpha.max() == 0:
            raise SystemExit(f"{name}: fully transparent")

        out_path = os.path.join(out_dir, name)
        img.save(out_path, "PNG")
        written[name] = out_path
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--brand-dir", default=os.environ.get("CURATOR_BRAND_ASSETS_DIR"),
                     help="Path to the design-system brand_assets root (containing png/app-icon/ and png/icon/). "
                          "No default — pass this or set CURATOR_BRAND_ASSETS_DIR.")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "images", "applet.icns"),
                     help="Output .icns path (default: images/applet.icns)")
    args = ap.parse_args()

    if not args.brand_dir:
        raise SystemExit("pass --brand-dir /path/to/brand_assets or set CURATOR_BRAND_ASSETS_DIR "
                          "(no default — the real path is a personal filesystem layout, never hardcoded here)")
    if not os.path.isdir(args.brand_dir):
        raise SystemExit(f"not a directory: {args.brand_dir}")

    with tempfile.TemporaryDirectory() as tmp:
        iconset_dir = os.path.join(tmp, "applet.iconset")
        os.makedirs(iconset_dir)
        build_iconset(args.brand_dir, iconset_dir)

        out_path = os.path.abspath(args.out)
        subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", out_path], check=True)
        print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
