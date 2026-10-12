"""Paprika Lyrics mark: the icon, the favicon and the .ico, drawn as code.

A paprika pepper with one band lit. The app's whole promise is a syllable
lighting up as it is sung, so the bright band is what is being sung and the
darker bands below it are the words still to come.

Drawn rather than stored for one reason that matters: each .ico frame is its
own drawing. At 16 px three bands, a stem and a leaf are mud, so the small
frames are a bigger, bolder pepper with a single band instead of a shrunken
copy of the large one.

The tile is deliberate too. The previous mark was a transparent near-black
glyph, which disappears against a dark taskbar or a dark-themed README; a tile
reads on any background, which is what an app icon has to do.

    python tools/logo.py

Writes assets/icon.png (512), ui/icon.png (512) -- the same mark, as before --
and assets/icon.ico with 16, 24, 32, 48, 64, 128 and 256 px frames.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
SS = 3                      # supersample factor for every frame
MASTER = 1024               # the tile everything else is reduced from

# Warm, dark, one hot band: the overlay's own palette.
# The tone ladder the mark relies on, darkest first: tile, then the pepper's own
# body, then the unsung bands, then the lit one. Each step has to be wide enough
# that the next one reads at 16 px, where there is no room for subtlety.
TILE_TOP = (56, 16, 14)
TILE_BOTTOM = (12, 4, 4)
TILE_RIM = (255, 176, 130)
GLOW = (232, 92, 48)
BODY_TOP = (112, 38, 25)
BODY_BOTTOM = (62, 18, 12)
# The sweep is kept light at its dark end on purpose: a deep red there lands at
# the same brightness as an unsung band, and the sung half of the pepper then
# stops reading as sung. Every stop stays clear of DIM's luma.
LIT = [(255, 220, 140), (252, 152, 54), (238, 100, 40)]
DIM = (152, 64, 42)
STEM = (94, 158, 72)
STEM_DARK = (62, 112, 48)

# The pepper as cubic Bezier segments, in tile-relative units: shoulders at the
# top, an S-curve down to a blunt tip. A paprika, not a chili.
BODY_PATH = [
    ((0.315, 0.335), (0.270, 0.500), (0.300, 0.645), (0.415, 0.780)),
    ((0.415, 0.780), (0.455, 0.840), (0.520, 0.868), (0.578, 0.828)),
    ((0.578, 0.828), (0.645, 0.782), (0.695, 0.660), (0.703, 0.545)),
    ((0.703, 0.545), (0.712, 0.428), (0.662, 0.344), (0.560, 0.318)),
    ((0.560, 0.318), (0.470, 0.296), (0.368, 0.298), (0.315, 0.335)),
]

# Vertical fraction of the body each band covers: the lit one, then the unsung
# ones under it. The gaps between them are the line breaks.
LIT_BAND = (0.075, 0.300)
DIM_BANDS = ((0.360, 0.585), (0.645, 0.870))

STEM_PATH = ((0.498, 0.318), (0.486, 0.278), (0.470, 0.236), (0.452, 0.196))
LEAF_PATH = ((0.404, 0.206), (0.372, 0.146), (0.316, 0.150), (0.352, 0.222))


def cubic(p0, p1, p2, p3, steps=72):
    out = []
    for i in range(steps + 1):
        t = i / steps
        m = 1.0 - t
        out.append((
            m ** 3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t ** 3 * p3[0],
            m ** 3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t ** 3 * p3[1],
        ))
    return out


def outline(segments, steps=72):
    points = []
    for segment in segments:
        piece = cubic(*segment, steps=steps)
        points.extend(piece if not points else piece[1:])
    return points


def vertical_gradient(size, top, bottom, y_range=(0.0, 1.0)):
    """`y_range` maps the ramp onto a band of the canvas rather than all of it.

    That matters: a pepper does not reach the top or the bottom of the tile it
    sits in, so a ramp drawn across the whole canvas gives the pepper only its
    middle tones -- the lightest and darkest ends of the palette never appear.
    """
    width, height = size
    y0, y1 = y_range
    strip = Image.new("RGB", (1, height))
    for y in range(height):
        t = (y / max(1, height - 1) - y0) / max(1e-6, y1 - y0)
        t = min(1.0, max(0.0, t))
        strip.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return strip.resize((width, height))


def horizontal_gradient(size, stops, x_range=(0.0, 1.0)):
    """stops: [(position 0..1, rgb), ...] in ascending order, over `x_range`."""
    width, height = size
    x0, x1 = x_range
    strip = Image.new("RGB", (width, 1))
    for x in range(width):
        t = (x / max(1, width - 1) - x0) / max(1e-6, x1 - x0)
        t = min(1.0, max(0.0, t))
        low, high = stops[0], stops[-1]
        for i in range(len(stops) - 1):
            if stops[i][0] <= t <= stops[i + 1][0]:
                low, high = stops[i], stops[i + 1]
                break
        span = max(1e-6, high[0] - low[0])
        k = min(1.0, max(0.0, (t - low[0]) / span))
        strip.putpixel((x, 0), tuple(round(low[1][i] + (high[1][i] - low[1][i]) * k)
                                     for i in range(3)))
    return strip.resize((width, height))


def radial_glow(size, strength, tightness=1.9):
    """A soft light behind the pepper, so the tile is not flat."""
    small = 96
    glow = Image.new("L", (small, small))
    for y in range(small):
        for x in range(small):
            dx = (x + 0.5) / small - 0.5
            dy = (y + 0.5) / small - 0.5
            r = min(1.0, ((dx * dx + dy * dy) ** 0.5) / 0.62)
            glow.putpixel((x, y), round(255 * strength * max(0.0, 1.0 - r) ** tightness))
    return glow.resize(size, Image.LANCZOS)


def band_mask(size, top, height, fractions):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rectangle(
        (0, top + fractions[0] * height, size[0], top + fractions[1] * height), fill=255)
    return mask


def build_mark(hi, simplified=False):
    """The pepper alone, on transparency, drawn at `hi` squared pixels."""
    def point(p):
        return (p[0] * hi, p[1] * hi)

    body = Image.new("L", (hi, hi), 0)
    ImageDraw.Draw(body).polygon([point(p) for p in outline(BODY_PATH)], fill=255)

    box = body.getbbox()
    left, top, right, bottom = box
    height = bottom - top

    mark = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    mark.paste(vertical_gradient((hi, hi), BODY_TOP, BODY_BOTTOM,
                                 y_range=(top / hi, bottom / hi)), (0, 0), body)

    def paint(fractions, stops):
        """One band, clipped to the body, its ramp spanning the band's own width."""
        mask = ImageChops.multiply(band_mask((hi, hi), top, height, fractions), body)
        x0, _, x1, _ = mask.getbbox()
        mark.paste(horizontal_gradient((hi, hi), stops, x_range=(x0 / hi, x1 / hi)),
                   (0, 0), mask)

    paint(LIT_BAND, [(0.0, LIT[0]), (0.55, LIT[1]), (1.0, LIT[2])])

    if not simplified:
        for fractions in DIM_BANDS:
            paint(fractions, [(0.0, DIM), (1.0, DIM)])

        stem = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
        draw = ImageDraw.Draw(stem)
        draw.line([point(p) for p in cubic(*STEM_PATH, steps=40)],
                  fill=STEM + (255,), width=max(2, int(hi * 0.030)), joint="curve")
        draw.polygon([point(p) for p in outline([
            (LEAF_PATH[0], LEAF_PATH[1], LEAF_PATH[2], LEAF_PATH[3]),
            (LEAF_PATH[3], LEAF_PATH[2], LEAF_PATH[1], LEAF_PATH[0]),
        ], steps=24)], fill=STEM_DARK + (255,))
        mark.alpha_composite(stem)
    return mark


def build_tile(size, simplified=False):
    hi = size * SS
    drawn = build_mark(hi, simplified=simplified)
    mark = drawn.crop(drawn.getbbox())

    fraction = 0.86 if simplified else 0.80
    scale = (hi * fraction) / max(mark.size)
    mark = mark.resize((max(1, round(mark.size[0] * scale)),
                        max(1, round(mark.size[1] * scale))), Image.LANCZOS)

    tile = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    mask = Image.new("L", (hi, hi), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, hi - 1, hi - 1),
                                           radius=int(hi * 0.225), fill=255)
    tile.paste(vertical_gradient((hi, hi), TILE_TOP, TILE_BOTTOM), (0, 0), mask)

    layer = Image.new("RGBA", (hi, hi), GLOW + (0,))
    # Kept faint: a strong halo lifts the tile behind the pepper and eats the
    # contrast the silhouette needs to read at small sizes.
    layer.putalpha(radial_glow((hi, hi), 0.14 if simplified else 0.20))
    tile.alpha_composite(Image.composite(layer, Image.new("RGBA", (hi, hi), (0, 0, 0, 0)), mask))

    tile.alpha_composite(mark, (int(hi * 0.5 - mark.size[0] * 0.5),
                                int(hi * 0.515 - mark.size[1] * 0.5)))

    rim = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    inset = int(hi * 0.012)
    ImageDraw.Draw(rim).rounded_rectangle(
        (inset, inset, hi - 1 - inset, hi - 1 - inset),
        radius=int(hi * 0.215), outline=TILE_RIM + (46,), width=max(1, int(hi * 0.008)))
    tile.alpha_composite(rim)

    return tile.resize((size, size), Image.LANCZOS) if size != hi else tile


ICO_SIZES = (256, 128, 64, 48, 32, 24, 16)


def frames():
    return [build_tile(s, simplified=s < 48) for s in ICO_SIZES]


def review_sheet():
    """A sheet for looking at the mark: the sizes side by side, and the ramp."""
    row = "".join(
        f'<figure><img src="logo-{s}.png" width="{max(s, 96)}"><figcaption>{s} px</figcaption></figure>'
        for s in (256, 48, 32, 24, 16))
    small = "".join(
        f'<figure><img class="px" src="logo-{s}.png" width="{96}"><figcaption>{s} px, {96 // s}x</figcaption></figure>'
        for s in (32, 24, 16))
    html = f"""<!doctype html><meta charset="utf-8"><title>Paprika Lyrics mark</title>
<style>
 body{{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#111}}
 h1{{font-size:18px}} h2{{font-size:14px;margin:28px 0 8px;color:#555;text-transform:uppercase;letter-spacing:.08em}}
 .row{{display:flex;gap:24px;align-items:flex-end;flex-wrap:wrap}}
 figure{{margin:0;text-align:center}} figcaption{{font-size:11px;color:#666;margin-top:6px}}
 .px{{image-rendering:pixelated}}
 .on-dark{{background:#0d0d0f;padding:20px;border-radius:10px}}
 .on-light{{background:#fff;padding:20px;border-radius:10px;border:1px solid #eee}}
 .pair{{display:flex;gap:20px}}
</style>
<h1>Paprika Lyrics — the mark</h1>
<h2>On a dark window, and on white</h2>
<div class="pair">
  <div class="on-dark"><img src="logo-256.png" width="160"></div>
  <div class="on-light"><img src="logo-256.png" width="160"></div>
</div>
<h2>The ramp</h2>
<div class="row">{row}</div>
<h2>Small frames, magnified (what the taskbar actually shows)</h2>
<div class="row">{small}</div>
<h2>Old mark, for comparison</h2>
<div class="pair">
  <div class="on-dark"><img src="old-icon.png" width="120"></div>
  <div class="on-light"><img src="old-icon.png" width="120"></div>
</div>
"""
    (BUILD / "logo-review.html").write_text(html, encoding="utf-8")


def report():
    """Numbers, because a mark can look fine in a sheet and be mush at 16 px."""
    print("frame   warm%   lit-band luma vs body   corners transparent")
    for size in (16, 24, 32, 48, 64, 256):
        tile = Image.open(BUILD / f"logo-{size}.png").convert("RGBA")
        px = list(tile.getdata())
        warm = [p for p in px if p[3] > 200 and p[0] > p[1] + 12 and p[0] > p[2] + 12]
        luma = sorted(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] for p in warm)
        peak = luma[int(len(luma) * 0.97)] if luma else 0
        mid = luma[len(luma) // 2] if luma else 0
        corner = tile.getpixel((0, 0))[3]
        print(f"{size:>5}   {100 * len(warm) / len(px):5.1f}   "
              f"{peak:5.1f} vs {mid:5.1f} ({peak / max(1.0, mid):.2f}x)      alpha={corner}")


def main():
    BUILD.mkdir(exist_ok=True)
    master = build_tile(MASTER)
    # The favicon and the README asset are the same mark, as they were before.
    master.resize((512, 512), Image.LANCZOS).save(ROOT / "assets" / "icon.png")
    master.resize((512, 512), Image.LANCZOS).save(ROOT / "ui" / "icon.png")

    built = frames()
    built[0].save(ROOT / "assets" / "icon.ico", format="ICO",
                  sizes=[(f.size[0], f.size[1]) for f in built], append_images=built[1:])
    master.save(BUILD / "logo-1024.png")
    for size in (16, 24, 32, 48, 64, 256):
        build_tile(size, simplified=size < 48).save(BUILD / f"logo-{size}.png")
    build_mark(768).save(BUILD / "logo-mark.png")
    review_sheet()

    with Image.open(ROOT / "assets" / "icon.ico") as ico:
        got = sorted(ico.info.get("sizes", []))
    print("wrote assets/icon.png (512), ui/icon.png (512), assets/icon.ico "
          f"frames={got}")
    report()


if __name__ == "__main__":
    main()
