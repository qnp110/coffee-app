#!/usr/bin/env python3
"""Generate the placeholder app icons (a brown coffee bean on a pastel peach-to-lavender gradient) as PNG files.

Pure standard library (zlib + struct), so no Pillow is needed.
Run from the repo root:  python3 tools/make_icons.py
Writes icons/apple-touch-icon.png (180), icons/icon-192.png and icons/icon-512.png.
"""
import math
import struct
import zlib
from pathlib import Path

BG_TOP = (247, 211, 191)     # #f7d3bf, pastel peach (--peach in style.css)
BG_BOTTOM = (224, 219, 245)  # #e0dbf5, pastel lavender (--lavender in style.css)
BEAN = (107, 72, 54)         # #6b4836, warm coffee brown
SUPERSAMPLE = 3          # 3x3 samples per pixel for smooth (anti-aliased) edges

# Bean geometry in normalised coordinates (0..1). The bean stays inside the central
# 80 % circle so the 512 px icon is also safe to use as a "maskable" Android icon.
CX, CY = 0.5, 0.5
SEMI_MINOR, SEMI_MAJOR = 0.24, 0.32  # ellipse half-axes
TILT = math.radians(-30)              # rotate the bean for a friendlier look
CREASE_AMPLITUDE, CREASE_HALF_WIDTH = 0.05, 0.022


def is_bean(x: float, y: float) -> bool:
    """Return True if the normalised point (x, y) lies on the bean (inside ellipse, outside crease)."""
    # Rotate the point into the bean's local frame: u across the bean, v along it.
    dx, dy = x - CX, y - CY
    u = dx * math.cos(TILT) - dy * math.sin(TILT)
    v = dx * math.sin(TILT) + dy * math.cos(TILT)
    if (u / SEMI_MINOR) ** 2 + (v / SEMI_MAJOR) ** 2 > 1:
        return False
    # The crease is an S-shaped band along the long axis, faded out near the tips.
    crease_u = CREASE_AMPLITUDE * math.sin(math.pi * v / SEMI_MAJOR)
    return not (abs(u - crease_u) < CREASE_HALF_WIDTH and abs(v) < 0.85 * SEMI_MAJOR)


def render(size: int) -> bytes:
    """Render the icon at size x size pixels and return raw scanlines for PNG (filter byte 0 per row)."""
    rows = []
    n = SUPERSAMPLE
    for py in range(size):
        row = bytearray([0])  # PNG filter type "None"
        # Vertical gradient: linear blend from BG_TOP (first row) to BG_BOTTOM (last row).
        s = py / (size - 1)
        bg = [top * (1 - s) + bottom * s for top, bottom in zip(BG_TOP, BG_BOTTOM)]
        for px in range(size):
            # Fraction of sub-samples that hit the bean -> blend factor between background and BEAN.
            hits = sum(
                is_bean((px + (i + 0.5) / n) / size, (py + (j + 0.5) / n) / size)
                for i in range(n) for j in range(n)
            )
            t = hits / (n * n)
            row.extend(round(b * (1 - t) + f * t) for b, f in zip(bg, BEAN))
        rows.append(bytes(row))
    return b"".join(rows)


def png_bytes(size: int) -> bytes:
    """Encode an RGB (8 bit, no alpha) PNG of the icon at the given size."""
    def chunk(kind: bytes, payload: bytes) -> bytes:
        # Each chunk: length, type, data, CRC over type + data.
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8 bit depth, colour type 2 = RGB
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(render(size), 9)) + chunk(b"IEND", b""))


def main() -> None:
    """Write all icon sizes into ./icons."""
    out = Path("icons")
    out.mkdir(exist_ok=True)
    for name, size in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
        (out / name).write_bytes(png_bytes(size))
        print(f"wrote {out / name} ({size}x{size})")


if __name__ == "__main__":
    main()
