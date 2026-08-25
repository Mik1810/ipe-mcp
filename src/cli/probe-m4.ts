#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { PNG } from "pngjs";

import { ipeDocumentCodec } from "../core/ipe-document-codec.js";
import { validateDocument } from "../domain/validate.js";
import { addBitmapAsset } from "../objects/assets.js";
import { buildFittedImageObject, buildGroupObject, buildPathObject, buildSymbolObject, buildTextObject } from "../objects/builders.js";
import { buildStylesheet, checkStyleStructural } from "../objects/styles.js";

const output = process.argv[2];
if (!output) throw new Error("usage: probe-m4 OUTPUT.ipe");

const document = ipeDocumentCodec.parse('<ipe version="70218" creator="ipe-mcp M4"><page><layer name="alpha"/><view layers="alpha" active="alpha"/></page></ipe>');
const page = document.pages[0]!;
const layerId = page.layers[0]!.id;

const styles = buildStylesheet("style-000000000000000000000004", "ipe-mcp-m4", [
  { kind: "color", name: "brandblue", value: [0.1, 0.3, 0.85] },
  { kind: "color", name: "accent", value: [0.9, 0.2, 0.15] },
  { kind: "opacity", name: "half", value: 0.5 },
  { kind: "arrowsize", name: "compact", value: 6 },
  { kind: "tiling", name: "hatch", angle: 30, width: 1, step: 6 },
  { kind: "gradient", name: "sunset", type: "axial", coords: [80, 0, 160, 0], stops: [{ offset: 0, color: [1, 0.8, 0] }, { offset: 1, color: [0.8, 0, 0.4] }] },
  {
    kind: "symbol", name: "mark/ipe-mcp(sx)", transformations: "translations",
    object: { type: "element", name: "path", attributes: { fill: "sym-stroke" }, children: [{ type: "text", text: "0.8 0 0 0.8 0 0 e" }] },
  },
]);
document.stylesheets = [styles];

const bitmap = new PNG({ width: 2, height: 2 });
bitmap.data.set([
  255, 30, 30, 255, 30, 255, 30, 160,
  30, 30, 255, 255, 255, 220, 30, 255,
]);
const asset = addBitmapAsset(document, PNG.sync.write(bitmap), "image/png").asset;
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z", "base64");
const jpegAsset = addBitmapAsset(document, jpeg, "image/jpeg").asset;

page.objects = [
  buildPathObject({ layerId, path: { kind: "point", point: { x: 40, y: 40 }, style: { stroke: "black", pen: "1.2" } } }),
  buildPathObject({ layerId, path: { kind: "segment", from: { x: 55, y: 40 }, to: { x: 120, y: 40 }, style: { stroke: "brandblue", farrow: true, farrowshape: "normal", farrowsize: "compact" } } }),
  buildPathObject({ layerId, path: { kind: "rounded-rectangle", x: 40, y: 65, width: 100, height: 55, radius: 10, style: { fill: "accent", gradient: "sunset", stroke: "black" } } }),
  buildPathObject({ layerId, path: { kind: "circle", center: { x: 190, y: 92 }, radius: 28, style: { fill: "brandblue", opacity: "half", stroke: "black" } } }),
  buildPathObject({ layerId, path: { kind: "uniform", points: [{ x: 40, y: 160 }, { x: 80, y: 205 }, { x: 120, y: 135 }, { x: 160, y: 180 }], style: { stroke: "accent", pen: "0.8" } } }),
  buildPathObject({ layerId, path: { kind: "cardinal", points: [{ x: 190, y: 155 }, { x: 225, y: 205 }, { x: 260, y: 145 }, { x: 300, y: 185 }], tension: 0.5, style: { stroke: "brandblue" } } }),
  buildPathObject({ layerId, path: { kind: "clothoid", points: [{ x: 330, y: 145 }, { x: 360, y: 205 }, { x: 405, y: 160 }], style: { stroke: "black" } } }),
  buildPathObject({ layerId, path: { kind: "compound", style: { fill: "accent", fillrule: "evenodd", tiling: "hatch" }, subpaths: [
    { kind: "rectangle", x: 260, y: 50, width: 95, height: 65 },
    { kind: "circle", center: { x: 308, y: 82 }, radius: 20 },
  ] } }),
  buildTextObject({ layerId, text: "$\\int_0^1 x^2\\,dx = \\frac{1}{3}$", position: { x: 40, y: 255 }, size: 14, stroke: "black" }),
  buildFittedImageObject({ layerId, asset, target: { x: 390, y: 40, width: 110, height: 75 }, fit: "cover" }),
  buildGroupObject({ layerId, matrix: [1, 0, 0, 1, 0, 20], children: [
    buildPathObject({ layerId, path: { kind: "rectangle", x: 390, y: 150, width: 90, height: 45, style: { fill: "brandblue" } } }),
    buildTextObject({ layerId, text: "group", position: { x: 415, y: 170 }, stroke: "white" }),
  ] }),
  buildSymbolObject({ layerId, name: "mark/ipe-mcp(sx)", position: { x: 520, y: 90 }, stroke: "accent", size: 12 }),
];
page.objects.forEach((object, index) => { object.zOrder = index; });

const secondLayerId = "layer-000000000000000000000004";
const second = {
  id: "page-000000000000000000000004",
  title: "M4 primitive matrix",
  layers: [{ id: secondLayerId, name: "primitives" }],
  views: [{ id: "view-000000000000000000000004", visibleLayerIds: [secondLayerId], activeLayerId: secondLayerId, marked: false }],
  objects: [
    buildPathObject({ layerId: secondLayerId, path: { kind: "polyline", points: [{ x: 30, y: 40 }, { x: 60, y: 70 }, { x: 90, y: 40 }], style: { stroke: "black" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "polygon", points: [{ x: 120, y: 40 }, { x: 155, y: 75 }, { x: 190, y: 40 }], style: { fill: "accent" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "rectangle", x: 220, y: 35, width: 65, height: 45, style: { stroke: "brandblue" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "ellipse", center: { x: 340, y: 58 }, rx: 42, ry: 20, rotationDegrees: 20, style: { fill: "brandblue", opacity: "half" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "arc", center: { x: 440, y: 60 }, rx: 38, ry: 25, startAngleDegrees: 20, endAngleDegrees: 300, direction: "cw", style: { stroke: "accent" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "quadratic", from: { x: 30, y: 130 }, control: { x: 80, y: 200 }, to: { x: 130, y: 130 }, style: { stroke: "brandblue" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "cubic", from: { x: 160, y: 130 }, control1: { x: 190, y: 205 }, control2: { x: 250, y: 65 }, to: { x: 285, y: 145 }, style: { stroke: "black" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "uniform", closed: true, points: [{ x: 330, y: 125 }, { x: 370, y: 190 }, { x: 420, y: 125 }, { x: 375, y: 95 }], style: { fill: "accent", stroke: "black" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "catmull-rom", points: [{ x: 470, y: 125 }, { x: 500, y: 190 }, { x: 540, y: 125 }, { x: 575, y: 165 }], style: { stroke: "accent" } } }),
    buildPathObject({ layerId: secondLayerId, path: { kind: "raw", style: { stroke: "brandblue" }, subpaths: [
      { commands: [
        { op: "m", point: { x: 150, y: 235 } },
        { op: "l", point: { x: 175, y: 250 } },
        { op: "c", control1: { x: 185, y: 270 }, control2: { x: 210, y: 270 }, to: { x: 220, y: 250 } },
        { op: "a", matrix: [12, 0, 0, 12, 220, 250], to: { x: 232, y: 250 } },
        { op: "s", points: [{ x: 245, y: 270 }, { x: 260, y: 250 }] },
        { op: "C", points: [{ x: 275, y: 230 }, { x: 290, y: 255 }], tension: 0.5 },
        { op: "L", points: [{ x: 305, y: 240 }, { x: 320, y: 260 }] },
        { op: "h" },
      ] },
      { commands: [{ op: "e", matrix: [25, 0, 0, 25, 365, 255] }] },
      { commands: [{ op: "u", points: [{ x: 405, y: 235 }, { x: 430, y: 270 }, { x: 455, y: 235 }] }] },
    ] } }),
    buildFittedImageObject({ layerId: secondLayerId, asset: jpegAsset, target: { x: 30, y: 235, width: 80, height: 55 }, fit: "stretch" }),
    buildTextObject({ layerId: secondLayerId, type: "minipage", text: "M4 minipage $x^2$", position: { x: 340, y: 300 }, width: 180, height: 30, horizontalAlign: "center", stroke: "black" }),
  ],
};
second.objects.forEach((object, index) => { object.zOrder = index; });
document.pages.push(second);

const structural = validateDocument(document).errors;
if (structural.length > 0) throw new Error(`M4 structural diagnostics: ${JSON.stringify(structural)}`);
const styleDiagnostics = checkStyleStructural(document);
if (styleDiagnostics.length > 0) throw new Error(`M4 style diagnostics: ${JSON.stringify(styleDiagnostics)}`);
await writeFile(output, ipeDocumentCodec.serialize(document), "utf8");
