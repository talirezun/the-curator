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
    128..1024 physical px → the brand's own pre-composited PNGs, copied as-is

All resizing goes through premultiplied alpha (see `resize_rgba`), because a
naive resize of straight (non-premultiplied) RGBA blends the fully-transparent
canvas colour into edge pixels near the rounded corners and produces a visible
dark halo.

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


def composite_coarse(tile_px, mark_source_path, supersample=SUPERSAMPLE):
    """Tile (rendered) + the coarse mark, placed exactly where the brand
    app-icon SVG places the fine mark (translate 13,13 scale 1.02 of a 128-unit
    tile) so a small icns entry keeps the same proportions as the large ones."""
    S = tile_px * supersample
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

    return resize_rgba(composite, (tile_px, tile_px))


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
        if px in (128, 256, 512, 1024):
            img = Image.open(brand_app_icon(px)).convert("RGBA")
            if img.size != (px, px):
                raise SystemExit(f"{brand_app_icon(px)} is {img.size}, expected {(px, px)}")
        elif px == 64:
            # Fine cut, downsampled — 64 physical px is ABOVE the 48px coarse
            # threshold, so this is a plain high-quality downsample, not a
            # re-composite with the coarse mark.
            img = resize_rgba(largest_fine, (64, 64))
        elif px in (16, 32):
            assert px <= COARSE_CUTOFF_PX
            img = composite_coarse(px, largest_coarse_mark)
        else:
            raise SystemExit(f"unexpected iconset size {px}")

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
