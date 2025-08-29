"""Map image bulk converter

Usage (examples):
  python map_img_convert.py --src ../api-assets-master/Assets/Maps --out ../webp-maps --quality 70 --max-size 4096
  python map_img_convert.py --src ../api-assets-master/Assets/Maps --out ../webp-maps-lossless --lossless

Converts *_High_Res.png (with text) to WebP. Skips *_No_Text_* and Low_Res versions.
Resizes down if image's longest side exceeds --max-size (unless 0 / omitted).

Requires: Pillow, tqdm
  pip install pillow tqdm
"""
from __future__ import annotations
import argparse
from pathlib import Path
from typing import Iterable
from PIL import Image

try:
    from tqdm import tqdm  # type: ignore
except ImportError:  # degrade gracefully
    def tqdm(x: Iterable, **_):  # type: ignore
        return x


def collect_targets(src: Path):
    for p in src.iterdir():
        if not p.is_file():
            continue
        name = p.name
        if not name.endswith('_High_Res.png'):
            continue
        if '_No_Text_' in name:  # skip no-text variant per request
            continue
        yield p


def process_image(path: Path, out_dir: Path, quality: int, max_side: int, lossless: bool):
    try:
        img = Image.open(path)
    except Exception as e:  # pragma: no cover (diagnostic)
        print(f"[skip] {path.name}: open failed: {e}")
        return

    img = img.convert('RGBA')  # preserve alpha if exists
    w, h = img.size
    if max_side and max(w, h) > max_side:
        scale = max_side / float(max(w, h))
        new_size = (int(w * scale + 0.5), int(h * scale + 0.5))
        img = img.resize(new_size, Image.LANCZOS)
        w, h = img.size

    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / (path.stem + '.webp')
    params = {"method": 6}
    if lossless:
        params.update(lossless=True, quality=quality)
    else:
        params.update(quality=quality)
    try:
        img.save(out_file, 'WEBP', **params)
    except Exception as e:  # pragma: no cover
        print(f"[fail] {path.name}: {e}")
        return
    size_mb = out_file.stat().st_size / (1024 * 1024)
    print(f"[ok] {path.name} -> {out_file.name} ({w}x{h}) {size_mb:.2f}MB")


def main():
    ap = argparse.ArgumentParser(description='Convert PUBG map images to WebP.')
    ap.add_argument('--src', default='api-assets-master/Assets/Maps', help='Source directory containing *_High_Res.png')
    ap.add_argument('--out', default='converted-webp', help='Output directory')
    ap.add_argument('--quality', type=int, default=70, help='WebP quality (lossy or lossless)')
    ap.add_argument('--max-size', type=int, default=8192, help='Clamp longest side (0 = no resize)')
    ap.add_argument('--lossless', action='store_true', help='Use WebP lossless mode (larger files)')
    args = ap.parse_args()

    src = Path(args.src)
    if not src.exists():
        print(f"[error] src not found: {src}")
        return 1

    targets = list(collect_targets(src))
    if not targets:
        print('[info] No High_Res targets found.')
        return 0

    print(f"[info] Converting {len(targets)} images (quality={args.quality}, max={args.max_size or 'original'}, lossless={args.lossless})")
    out_dir = Path(args.out)
    for p in tqdm(targets, desc='convert'):
        process_image(p, out_dir, args.quality, args.max_size if args.max_size > 0 else 0, args.lossless)

    return 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
