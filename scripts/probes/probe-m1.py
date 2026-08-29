#!/usr/bin/env python3
"""Emit a deterministic semantic diff for one native Ipe XML round-trip.

The three paths are deliberately explicit: SOURCE ROUNDTRIP and, optionally,
NATIVE_COPY.  No command, current directory, or environment variable is used
to find an input document.  XML formatting, creator strings, and path names do
not appear in the result.
"""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


OBJECT_TAGS = {"group", "image", "path", "text", "use"}


def _text(value: str | None) -> str | None:
    return None if value is None else " ".join(value.split())


def _view_layers(value: str | None) -> list[str]:
    return [] if value is None else value.split()


def _canonical_object(element: ET.Element) -> dict[str, Any]:
    attributes = {
        name: _text(value)
        for name, value in sorted(element.attrib.items())
        if name not in {"layer", "custom"} and not name.startswith("x-")
    }
    if element.tag == "text":
        attributes.setdefault("type", "label")
        attributes.setdefault(
            "valign", "top" if attributes["type"] == "minipage" else "bottom"
        )
        content = element.text or ""
    elif element.tag == "path":
        content = _text(element.text)
    else:
        content = None
    return {
        "tag": element.tag,
        "attributes": attributes,
        "content": content,
        "children": [
            _canonical_object(child)
            for child in list(element)
            if child.tag in OBJECT_TAGS
        ],
    }


def _walk_objects(element: ET.Element, location: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if element.tag in OBJECT_TAGS:
        result.append(
            {
                "path": location,
                "tag": element.tag,
                "layer": element.get("layer"),
                "custom": element.get("custom"),
                "matrix": _text(element.get("matrix")),
                "url": element.get("url"),
            }
        )
    for index, child in enumerate(list(element), 1):
        result.extend(_walk_objects(child, f"{location}/{child.tag}[{index}]"))
    return result


def _unknown_x(root: ET.Element) -> dict[str, Any]:
    attributes: list[dict[str, str]] = []
    elements: list[dict[str, Any]] = []

    def visit(element: ET.Element, location: str) -> None:
        for name, value in sorted(element.attrib.items()):
            if name.startswith("x-"):
                attributes.append({"path": location, "name": name, "value": value})
        if element.tag.startswith("x-"):
            elements.append(
                {
                    "path": location,
                    "tag": element.tag,
                    "attributes": dict(sorted(element.attrib.items())),
                    "text": _text(element.text),
                }
            )
        for index, child in enumerate(list(element), 1):
            visit(child, f"{location}/{child.tag}[{index}]")

    visit(root, root.tag)
    return {"attributes": attributes, "elements": elements}


def _summarize(path: Path) -> dict[str, Any]:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        raise SystemExit(f"probe input error: {path}: {exc}") from exc

    pages: list[dict[str, Any]] = []
    custom_order: list[str] = []
    object_order: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    effects: list[dict[str, Any]] = []
    layouts: list[dict[str, str | None]] = []
    style = root.find("ipestyle")
    if style is not None:
        for layout in style.findall("layout"):
            layouts.append(
                {name: _text(value) for name, value in sorted(layout.attrib.items())}
            )
        for effect in style.findall("effect"):
            effects.append(
                {
                    "name": effect.get("name"),
                    "duration": effect.get("duration"),
                    "transition": effect.get("transition"),
                    "effect": effect.get("effect"),
                }
            )

    for page_number, page in enumerate(root.findall("page"), 1):
        layers = [layer.get("name") for layer in page.findall("layer")]
        views: list[dict[str, Any]] = []
        for view_number, view in enumerate(page.findall("view"), 1):
            transforms = [
                {
                    "layer": transform.get("layer"),
                    "matrix": _text(transform.get("matrix")),
                }
                for transform in view.findall("transform")
            ]
            views.append(
                {
                    "number": view_number,
                    "layers": _view_layers(view.get("layers")),
                    "active": view.get("active"),
                    "marked": view.get("marked"),
                    "name": view.get("name"),
                    "effect": view.get("effect"),
                    "transforms": transforms,
                }
            )
        top_objects: list[dict[str, Any]] = []
        for object_number, object_element in enumerate(
            (child for child in list(page) if child.tag in OBJECT_TAGS), 1
        ):
            item = {
                "number": object_number,
                "tag": object_element.tag,
                "layer": object_element.get("layer"),
                "custom": object_element.get("custom"),
                "matrix": _text(object_element.get("matrix")),
                "url": object_element.get("url"),
            }
            top_objects.append(item)
            object_order.append({"page": page_number, **item})
            if object_element.tag == "group":
                groups.append(
                    {
                        "page": page_number,
                        "number": object_number,
                        "url": object_element.get("url"),
                    }
                )
        all_objects = _walk_objects(page, f"page[{page_number}]")
        for item in all_objects:
            if item["custom"] is not None:
                custom_order.append(item["custom"])
        pages.append(
            {
                "number": page_number,
                "layers": layers,
                "views": views,
                "objects": top_objects,
            }
        )

    return {
        "root_version": root.get("version"),
        "pages": pages,
        "custom_order": custom_order,
        "object_order": object_order,
        "supported_payload": [
            _canonical_object(child)
            for page in root.findall("page")
            for child in list(page)
            if child.tag in OBJECT_TAGS
        ],
        "groups": groups,
        "unknown_x": _unknown_x(root),
        "layouts": layouts,
        "effects": effects,
    }


def _diff(source: Any, roundtrip: Any) -> dict[str, Any]:
    return {"source": source, "roundtrip": roundtrip, "equal": source == roundtrip}


def _default_materialization(source: dict[str, Any], roundtrip: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    source_pages = source["pages"]
    roundtrip_pages = roundtrip["pages"]
    for page_number, (before, after) in enumerate(zip(source_pages, roundtrip_pages), 1):
        if not before["layers"] and after["layers"]:
            changes.append({"page": page_number, "field": "layers", "source": [], "roundtrip": after["layers"]})
        if not before["views"] and after["views"]:
            changes.append({"page": page_number, "field": "views", "source": [], "roundtrip": after["views"]})
        for view_number, (before_view, after_view) in enumerate(
            zip(before["views"], after["views"]), 1
        ):
            for field in ("active", "marked"):
                if before_view[field] is None and after_view[field] is not None:
                    changes.append(
                        {
                            "page": page_number,
                            "view": view_number,
                            "field": field,
                            "source": None,
                            "roundtrip": after_view[field],
                        }
                    )
        for object_number, (before_object, after_object) in enumerate(
            zip(before["objects"], after["objects"]), 1
        ):
            if before_object["layer"] is None and after_object["layer"] is not None:
                changes.append(
                    {
                        "page": page_number,
                        "object": object_number,
                        "field": "layer",
                        "source": None,
                        "roundtrip": after_object["layer"],
                    }
                )
    return changes


def _native_summary(path: Path) -> dict[str, Any]:
    summary = _summarize(path)
    return {
        "custom_order": summary["custom_order"],
        "object_order": summary["object_order"],
        "pages": summary["pages"],
        "groups": summary["groups"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("roundtrip", type=Path)
    parser.add_argument("native_copy_pos", type=Path, nargs="?")
    parser.add_argument("--native-copy", dest="native_copy_opt", type=Path)
    args = parser.parse_args()
    if args.native_copy_pos is not None and args.native_copy_opt is not None:
        parser.error("native copy supplied twice")
    native_path = args.native_copy_opt or args.native_copy_pos

    source = _summarize(args.source)
    roundtrip = _summarize(args.roundtrip)
    result: dict[str, Any] = {
        "format": 1,
        "file_format": "70218",
        "checks": {
            "root_version": _diff(source["root_version"], roundtrip["root_version"]),
            "custom": _diff(source["custom_order"], roundtrip["custom_order"]),
            "unknown_x": _diff(source["unknown_x"], roundtrip["unknown_x"]),
            "default_materialized": _default_materialization(source, roundtrip),
            # A native writer is allowed to elide the redundant layer on an
            # object; z-order/custom identity is therefore compared by the
            # stable custom sequence, not by incidental object attributes.
            "order_custom": _diff(source["custom_order"], roundtrip["custom_order"]),
            "supported_payload": _diff(
                {
                    "layouts": source["layouts"],
                    "objects": source["supported_payload"],
                },
                {
                    "layouts": roundtrip["layouts"],
                    "objects": roundtrip["supported_payload"],
                },
            ),
            "layer_view_active_marked": _diff(source["pages"], roundtrip["pages"]),
            "group_url": _diff(source["groups"], roundtrip["groups"]),
            "view_transform": _diff(
                [[view["transforms"] for view in page["views"]] for page in source["pages"]],
                [[view["transforms"] for view in page["views"]] for page in roundtrip["pages"]],
            ),
            "effects_0_27": _diff(source["effects"], roundtrip["effects"]),
        },
        "native_copy": None if native_path is None else _native_summary(native_path),
    }
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
