"""Experimental mapping of a small, explicitly checked Ipe scene into Manim."""
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from manim import BLACK, WHITE, MathTex, ManimColor, Polygon, Scene, config, linear

WIDTH, HEIGHT, SCALE = 320, 180, 1 / 45
config.pixel_width, config.pixel_height, config.frame_rate = WIDTH, HEIGHT, 20
config.frame_width, config.frame_height = WIDTH * SCALE, HEIGHT * SCALE
config.background_color = WHITE

polygon = re.compile(r"^(\d+) (\d+) m(?: (\d+) (\d+) l)+ h$")


def point(x, y):
    return ((float(x) - WIDTH / 2) * SCALE, (float(y) - HEIGHT / 2) * SCALE, 0)


def fixture(path):
    with path.open("rb") as stream:
        source = stream.read(64 * 1024 + 1)
    if len(source) > 64 * 1024 or b"<!ENTITY" in source:
        raise ValueError("UNSUPPORTED_XML")
    root = ET.fromstring(source)
    if root.tag != "ipe" or root.attrib.get("version") != "70218":
        raise ValueError("UNSUPPORTED_IPE_FORMAT")
    expected_layout = {"paper": "320 180", "origin": "0 0", "frame": "320 180"}
    if [child.tag for child in root] != ["ipestyle", "page"] or len(root[0]) != 1 or root[0][0].tag != "layout" or root[0][0].attrib != expected_layout:
        raise ValueError("UNSUPPORTED_STYLESHEET")
    pages = root.findall("page")
    if len(pages) != 1:
        raise ValueError("UNSUPPORTED_PAGE_COUNT")
    page = pages[0]
    if page.attrib:
        raise ValueError("UNSUPPORTED_PAGE_ATTRIBUTES")
    if any("clip" in element.attrib for element in page.iter()):
        raise ValueError("UNSUPPORTED_CLIP")
    if any("gradient" in element.attrib for element in page.iter()):
        raise ValueError("UNSUPPORTED_GRADIENT")
    if any(element.tag not in {"layer", "view", "path", "text"} for element in page):
        raise ValueError("UNSUPPORTED_OBJECT")
    views = page.findall("view")
    if (len(views) != 2 or views[0].attrib != views[1].attrib
            or set(views[0].attrib) != {"layers", "active"}
            or views[0].get("layers", "").split() != [layer.get("name") for layer in page.findall("layer")]):
        raise ValueError("UNSUPPORTED_VIEW_SEQUENCE")
    if list(views[0]) or len(views[1]) != 1 or views[1][0].tag != "transform":
        raise ValueError("UNSUPPORTED_VIEW_TRANSFORM")
    transform = views[1][0]
    matrix = transform.attrib.get("matrix", "").split()
    if len(matrix) != 6 or matrix[:4] != ["1", "0", "0", "1"]:
        raise ValueError("UNSUPPORTED_AFFINE_TRANSFORM")
    return page, transform.attrib["layer"], (float(matrix[4]) * SCALE, float(matrix[5]) * SCALE, 0)


class IpeTranslation(Scene):
    def construct(self):
        page, moving_layer, delta = fixture(Path(os.environ["IPE_MANIM_SPIKE_INPUT"]))
        moving = []
        for element in page:
            if element.tag in {"layer", "view"}:
                continue
            layer = element.attrib["layer"]
            if element.tag == "path":
                raw = " ".join((element.text or "").split())
                if set(element.attrib) != {"layer", "fill"} or not polygon.fullmatch(raw):
                    raise ValueError("UNSUPPORTED_PATH")
                vertices = [point(x, y) for x, y in re.findall(r"(\d+) (\d+) [ml]", raw)]
                rgb = tuple(float(value) for value in element.attrib["fill"].split())
                if len(rgb) != 3 or not all(0 <= value <= 1 for value in rgb):
                    raise ValueError("UNSUPPORTED_COLOR")
                item = Polygon(*vertices, fill_color=ManimColor(rgb), fill_opacity=1, stroke_width=0)
            else:
                raw = element.text or ""
                if (set(element.attrib) != {"layer", "type", "pos", "size", "stroke"} or element.get("type") != "label"
                        or element.get("size") != "16" or element.get("stroke") != "0"
                        or not re.fullmatch(r"\$[xy^+0-9]+\$", raw)):
                    raise ValueError("UNSUPPORTED_TEX_LABEL")
                item = MathTex(raw[1:-1], color=BLACK, font_size=36)
                x, y = element.attrib["pos"].split()
                left = item.get_left()
                bottom = item.get_bottom()
                target = point(x, y)
                item.shift((target[0] - left[0], target[1] - bottom[1], 0))
            self.add(item)
            if layer == moving_layer:
                moving.append(item)
        if len(moving) != 1:
            raise ValueError("UNSUPPORTED_MOVING_LAYER")
        self.wait(0.1)
        self.play(moving[0].animate.shift(delta), run_time=1, rate_func=linear)
        self.wait(0.1)
