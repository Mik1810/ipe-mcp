#!/usr/bin/env python3
"""Validate uncompressed PDF structures emitted by Ipe 7.2.30 for M1."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


OBJECT_RE = re.compile(rb"(?ms)^(\d+) 0 obj\s*(.*?)\s*endobj\s*$")
REF_RE = re.compile(r"(\d+)\s+0\s+R")


def _objects(path: Path) -> dict[int, str]:
    data = path.read_bytes()
    objects = {
        int(match.group(1)): match.group(2).decode("latin-1")
        for match in OBJECT_RE.finditer(data)
    }
    if not objects:
        raise SystemExit("PDF probe found no classic objects; use ipetoipe -nozip")
    return objects


def _pages(objects: dict[int, str]) -> list[str]:
    roots = [body for body in objects.values() if re.search(r"/Type\s*/Pages\b", body)]
    if len(roots) != 1:
        raise SystemExit(f"expected one /Pages tree, got {len(roots)}")
    kids_match = re.search(r"/Kids\s*\[(.*?)\]", roots[0], re.S)
    if not kids_match:
        raise SystemExit("page tree has no /Kids")
    refs = [int(value) for value in REF_RE.findall(kids_match.group(1))]
    try:
        return [objects[ref] for ref in refs]
    except KeyError as exc:
        raise SystemExit(f"missing page object {exc.args[0]}") from exc


def _dictionary(page: str, key: str) -> str | None:
    match = re.search(rf"/{re.escape(key)}\s*<<(.*?)>>", page, re.S)
    return None if match is None else " ".join(match.group(1).split())


def _box(page: str, key: str) -> list[float] | None:
    match = re.search(rf"/{re.escape(key)}\s*\[([^]]+)\]", page)
    return None if match is None else [float(value) for value in match.group(1).split()]


def _validate_effects(objects: dict[int, str]) -> dict[str, object]:
    pages = _pages(objects)
    expected = [
        None,
        "/D 1 /S /Split /Dm /H /M /I",
        "/D 1 /S /Split /Dm /H /M /O",
        "/D 1 /S /Split /Dm /V /M /I",
        "/D 1 /S /Split /Dm /V /M /O",
        "/D 1 /S /Blinds /Dm /H",
        "/D 1 /S /Blinds /Dm /V",
        "/D 1 /S /Box /M /I",
        "/D 1 /S /Box /M /O",
        "/D 1 /S /Wipe /Di 0",
        "/D 1 /S /Wipe /Di 90",
        "/D 1 /S /Wipe /Di 180",
        "/D 1 /S /Wipe /Di 270",
        "/D 1 /S /Dissolve",
        "/D 1 /S /Glitter /Di 0",
        "/D 1 /S /Glitter /Di 270",
        "/D 1 /S /Glitter /Di 315",
        "/D 1 /S /Fly /M /I /Di 0",
        "/D 1 /S /Fly /M /O /Di 0",
        "/D 1 /S /Fly /M /I /Di 270",
        "/D 1 /S /Fly /M /O /Di 270",
        "/D 1 /S /Push /Di 0",
        "/D 1 /S /Push /Di 270",
        "/D 1 /S /Cover /Di 0",
        "/D 1 /S /Cover /Di 270",
        "/D 1 /S /Uncover /Di 0",
        "/D 1 /S /Uncover /Di 270",
        "/D 1 /S /Fade",
    ]
    actual = [_dictionary(page, "Trans") for page in pages]
    if actual != expected:
        different = [index for index, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1]]
        raise SystemExit(f"effect PDF transition mismatch on zero-based pages {different}")
    return {"pages": len(pages), "transitions": sum(value is not None for value in actual)}


def _validate_bbox(objects: dict[int, str]) -> dict[str, object]:
    pages = _pages(objects)
    if len(pages) != 2:
        raise SystemExit(f"bbox PDF expected 2 pages, got {len(pages)}")
    media = [_box(page, "MediaBox") for page in pages]
    crop = [_box(page, "CropBox") for page in pages]
    art = [_box(page, "ArtBox") for page in pages]
    if media != [[0.0, 0.0, 260.0, 190.0]] * 2:
        raise SystemExit(f"bbox PDF MediaBox mismatch: {media}")
    expected_crop = [[19.8, 19.8, 240.2, 170.2], [-0.2, -0.2, 260.2, 190.2]]
    if crop != expected_crop:
        raise SystemExit(f"bbox PDF CropBox mismatch: {crop}")
    if art != expected_crop:
        raise SystemExit(f"bbox PDF ArtBox mismatch: {art}")

    rectangles: list[list[float]] = []
    uris: list[str | None] = []
    for page in pages:
        annot_match = re.search(r"/Annots\s*\[(.*?)\]", page, re.S)
        refs = [] if annot_match is None else [int(value) for value in REF_RE.findall(annot_match.group(1))]
        if len(refs) != 1:
            raise SystemExit(f"bbox PDF expected one annotation per page, got {refs}")
        annotation = objects[refs[0]]
        rectangles.append(_box(annotation, "Rect") or [])
        uri_match = re.search(r"/URI\s*\(([^)]*)\)", annotation)
        uris.append(None if uri_match is None else uri_match.group(1))
    expected_rect = [55.0, 45.0, 165.0, 125.0]
    if rectangles != [expected_rect, expected_rect]:
        raise SystemExit(f"bbox PDF link rectangle mismatch: {rectangles}")
    expected_uri = "https://example.invalid/m1/group"
    if uris != [expected_uri, expected_uri]:
        raise SystemExit(f"bbox PDF link URI mismatch: {uris}")
    return {
        "pages": 2,
        "crop_boxes": crop,
        "art_boxes": art,
        "link_rectangles": rectangles,
        "link_rectangles_untransformed": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("effects", "bbox"))
    parser.add_argument("pdf", type=Path)
    args = parser.parse_args()
    objects = _objects(args.pdf)
    result = _validate_effects(objects) if args.mode == "effects" else _validate_bbox(objects)
    print(json.dumps({"mode": args.mode, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
