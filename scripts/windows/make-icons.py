#!/usr/bin/env python3
"""Dev-time only: generates the two Windows shortcut icons.

    python3 scripts/windows/make-icons.py [preview_dir]

Writes scripts/windows/assets/curator-start.ico (The Curator mark + green play badge)
and curator-stop.ico (same mark + red stop badge), each with 16, 24, 32, 48, 64, 128
and 256 px. The installer ships the committed .ico files; nothing runs this at install
time. Deterministic; reads only images/applet.icns (the Mac icon, best large rendering).
Optional preview_dir receives side-by-side PNGs (not committed).

Needs Pillow. Small sizes get a relatively larger badge so the cue stays legible.
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 8  # supersampling for the badge layer


def load_base():
    im = Image.open(os.path.join(ROOT, "images", "applet.icns"))
    try:
        im.size = max(im.info.get("sizes", [im.size]), key=lambda s: s[0] * s[1])
    except Exception:
        pass
    im = im.convert("RGBA")
    # Trim the macOS template padding and drop shadow: keep the solid tile.
    alpha = im.getchannel("A").point(lambda a: 255 if a > 200 else 0)
    box = alpha.getbbox()
    return im.crop(box)


def badge_frac(px):
    # Badge diameter as a fraction of the icon; larger when tiny.
    return {16: 0.72, 24: 0.66, 32: 0.60, 48: 0.52, 64: 0.46, 128: 0.42}.get(px, 0.40)


def badge_layer(px, kind):
    """Badge drawn supersampled on a px x px transparent layer, lower-right."""
    n = px * SS
    lay = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    dia = badge_frac(px) * n
    margin = 0.0
    x1 = n - margin
    y1 = n - margin
    x0, y0 = x1 - dia, y1 - dia
    ring = max(1.0, dia * (0.09 if px >= 48 else 0.10 if px >= 24 else 0.13))
    # dark halo so the badge separates from the light/dark tile at any size
    d.ellipse([x0, y0, x1, y1], fill=(255, 255, 255, 255))
    fill = (22, 163, 74, 255) if kind == "start" else (220, 38, 38, 255)
    d.ellipse([x0 + ring, y0 + ring, x1 - ring, y1 - ring], fill=fill)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (dia - 2 * ring) / 2
    white = (255, 255, 255, 255)
    if kind == "start":
        w, h = r * 0.95, r * 1.15
        left = cx - w * 0.42
        d.polygon([(left, cy - h / 2), (left, cy + h / 2), (left + w, cy)], fill=white)
    else:
        s = r * 0.50
        d.rectangle([cx - s, cy - s, cx + s, cy + s], fill=white)
    return lay.resize((px, px), Image.LANCZOS)


def render(base, px, kind):
    # Mark fills the canvas; badge overlaps the corner.
    inset = 0 if px <= 32 else max(1, round(px * 0.02))
    mark = base.resize((px - 2 * inset, px - 2 * inset), Image.LANCZOS)
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(mark, (inset, inset), mark)
    return Image.alpha_composite(out, badge_layer(px, kind))


def main():
    base = load_base()
    frames = {}
    for kind in ("start", "stop"):
        frames[kind] = {s: render(base, s, kind) for s in SIZES}
        path = os.path.join(HERE, "assets", f"curator-{kind}.ico")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Pillow builds the ico from the largest image; append_images are not used
        # for ICO, so sizes= resamples. Pass the hand-rendered 256 and let Pillow
        # embed each size from our own frames via bitmap_format-free PNG entries.
        frames[kind][256].save(
            path, format="ICO", sizes=[(s, s) for s in SIZES],
            append_images=[frames[kind][s] for s in SIZES if s != 256],
        )
    if len(sys.argv) > 1:
        preview(frames, sys.argv[1])


def preview(frames, outdir):
    os.makedirs(outdir, exist_ok=True)
    order = [256, 48, 32, 16]
    for bgname, bg in (("light", (243, 243, 247, 255)), ("dark", (24, 24, 32, 255))):
        W = sum(s + 40 for s in order) + 40
        im = Image.new("RGBA", (W, 2 * 256 + 120), bg)
        y = 30
        for kind in ("start", "stop"):
            x = 40
            for s in order:
                im.alpha_composite(frames[kind][s], (x, y + 256 - s))
                x += s + 40
            y += 256 + 40
        im.convert("RGB").save(os.path.join(outdir, f"icons-{bgname}.png"))
        # also a 3x-zoomed nearest-neighbour strip of the small sizes
        z = Image.new("RGBA", (4 * 3 * 48 + 100, 2 * 3 * 32 + 60), bg)
        yy = 20
        for kind in ("start", "stop"):
            xx = 20
            for s in (32, 24, 16):
                f = frames[kind][s].resize((s * 4, s * 4), Image.NEAREST)
                z.alpha_composite(f, (xx, yy))
                xx += s * 4 + 20
            yy += 32 * 4 + 20
        z.convert("RGB").save(os.path.join(outdir, f"icons-small-zoom-{bgname}.png"))


if __name__ == "__main__":
    main()
