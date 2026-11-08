import { SaxesParser } from "saxes";

import { ipeDocumentCodec, type IpeDocument } from "../core/ipe-document-codec.js";
import { IPE_FORMAT_VERSION, IR_SCHEMA_VERSION, type DocumentIR, type Matrix } from "../domain/ir.js";
import { assertDomainNumber } from "../domain/numeric.js";
import { IDENTITY_MATRIX, assertInvertibleMatrix, multiplyMatrices } from "../layout/matrix.js";
import { checkDocumentShapeLimits } from "../limits.js";
import { addBitmapAsset } from "../objects/assets.js";
import { compilePath, type PathSpec, type PathStyle } from "../objects/path.js";
import { rejectImport, VectorImportError } from "./errors.js";
import { parseSvgNumber, parseSvgPath, svgNumberList } from "./svg-path.js";

export const SVG_IMPORT_MAX_BYTES = 1024 * 1024;
const NS = "http://www.w3.org/2000/svg";
const xmlns = "http://www.w3.org/2000/xmlns/";
const geometry = {
  path: ["d"], rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"],
  image: ["x", "y", "width", "height", "href", "preserveAspectRatio"],
  line: ["x1", "y1", "x2", "y2"], polyline: ["points"], polygon: ["points"],
} as const;
const styleKeys = new Set(["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "opacity"]);
const cap = { butt: "0", round: "1", square: "2" } as const;
const join = { miter: "0", round: "1", bevel: "2" } as const;
const named = new Map(Object.entries({
  black: "000000", white: "ffffff", red: "ff0000", lime: "00ff00", blue: "0000ff", green: "008000",
  yellow: "ffff00", gray: "808080", grey: "808080", silver: "c0c0c0", maroon: "800000",
  purple: "800080", fuchsia: "ff00ff", aqua: "00ffff", navy: "000080", teal: "008080", olive: "808000",
}));
type Attributes = Record<string, string>;
interface Node { readonly name: string; readonly location: string; readonly attributes: Attributes; readonly children: Node[] }

function parseTree(input: Uint8Array): Node {
  if (input.byteLength === 0 || input.byteLength > SVG_IMPORT_MAX_BYTES) rejectImport("SVG_BYTE_LIMIT", "svg");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { return rejectImport("SVG_INVALID_UTF8", "svg"); }
  const parser = new SaxesParser({ xmlns: true, fragment: false });
  const stack: Node[] = [];
  let root: Node | undefined;
  let documentNamespace: string | undefined;
  let nodes = 0, attributes = 0;
  parser.on("doctype", () => rejectImport("SVG_DTD_FORBIDDEN", "svg"));
  parser.on("processinginstruction", () => rejectImport("SVG_PROCESSING_INSTRUCTION", "svg"));
  parser.on("error", () => rejectImport("SVG_INVALID_XML", stack.at(-1)?.location ?? "svg"));
  parser.on("text", (text) => { if (text.trim() !== "") rejectImport("SVG_TEXT_CONTENT_UNSUPPORTED", stack.at(-1)?.location ?? "svg"); });
  parser.on("cdata", () => rejectImport("SVG_CDATA_UNSUPPORTED", stack.at(-1)?.location ?? "svg"));
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    const location = parent === undefined ? "svg" : parent.location + ".child[" + parent.children.length + "]";
    if (++nodes > 2500 || stack.length >= 32) rejectImport("SVG_TREE_LIMIT", location);
    if (documentNamespace === undefined) documentNamespace = tag.uri;
    if (tag.uri !== documentNamespace || (tag.uri !== NS && tag.uri !== "")) rejectImport("SVG_NAMESPACE_UNSUPPORTED", location);
    if (parent === undefined ? tag.local !== "svg" : tag.local !== "g" && !Object.hasOwn(geometry, tag.local)) {
      if (tag.local === "text") rejectImport("SVG_TEXT_UNSUPPORTED", location);
      if (tag.local === "script" || tag.local === "foreignObject") rejectImport("SVG_ACTIVE_CONTENT", location);
      rejectImport("SVG_ELEMENT_UNSUPPORTED", location);
    }
    const attrs: Attributes = Object.create(null) as Attributes;
    for (const attr of Object.values(tag.attributes)) {
      if (++attributes > 8_000) rejectImport("SVG_ATTRIBUTE_LIMIT", location);
      if (attr.uri === xmlns && parent === undefined && attr.value === NS) continue;
      if (attr.uri !== "" || (attr.local === "href" && tag.local !== "image")) rejectImport("SVG_EXTERNAL_OR_NAMESPACED_REFERENCE", location);
      if (/^on/iu.test(attr.local)) rejectImport("SVG_ACTIVE_CONTENT", location);
      attrs[attr.local] = attr.value;
    }
    const node = { name: tag.local, location, attributes: attrs, children: [] as Node[] };
    if (parent === undefined) root = node;
    else parent.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(source).close();
  if (root === undefined) return rejectImport("SVG_ROOT_REQUIRED", "svg");
  return root;
}

function composed(a: Matrix, b: Matrix, location: string): Matrix {
  try { return multiplyMatrices(a, b); }
  catch { return rejectImport("SVG_TRANSFORM_LIMIT", location); }
}

function transform(value: string | undefined, location: string): Matrix {
  if (value === undefined) return IDENTITY_MATRIX;
  const pattern = /\s*([A-Za-z]+)\s*\(([^()]*)\)\s*/y;
  let cursor = 0;
  let result = IDENTITY_MATRIX;
  while (cursor < value.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(value);
    if (match === null) return rejectImport("SVG_INVALID_TRANSFORM", location);
    cursor = pattern.lastIndex;
    const a = svgNumberList(match[2]!, location);
    const x = a[0]!, y = a[1]!;
    let m: Matrix;
    switch (match[1]) {
      case "matrix": if (a.length !== 6) return rejectImport("SVG_INVALID_TRANSFORM", location); m = a as unknown as Matrix; break;
      case "translate": if (a.length < 1 || a.length > 2) return rejectImport("SVG_INVALID_TRANSFORM", location); m = [1, 0, 0, 1, x, y ?? 0]; break;
      case "scale": if (a.length < 1 || a.length > 2) return rejectImport("SVG_INVALID_TRANSFORM", location); m = [x, 0, 0, y ?? x, 0, 0]; break;
      case "rotate": {
        if (a.length !== 1 && a.length !== 3) return rejectImport("SVG_INVALID_TRANSFORM", location);
        const angle = x % 360 * Math.PI / 180;
        const c = Math.cos(angle), s = Math.sin(angle);
        const cx = y ?? 0, cy = a[2] ?? 0;
        m = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]; break;
      }
      case "skewX":
      case "skewY": {
        if (a.length !== 1 || Math.abs(x % 180) === 90) return rejectImport("SVG_INVALID_TRANSFORM", location);
        const t = Math.tan(x % 180 * Math.PI / 180);
        m = match[1] === "skewX" ? [1, 0, t, 1, 0, 0] : [1, t, 0, 1, 0, 0]; break;
      }
      default: return rejectImport("SVG_TRANSFORM_UNSUPPORTED", location);
    }
    result = composed(result, m, location);
    if (value[cursor] === ",") {
      cursor++;
      if (value.slice(cursor).trim() === "") rejectImport("SVG_INVALID_TRANSFORM", location);
    }
  }
  if (cursor === 0) rejectImport("SVG_INVALID_TRANSFORM", location);
  return result;
}

function aspectFit(width: number, height: number, sourceWidth: number, sourceHeight: number,
  preserve: string | undefined, location: string): [number, number, number, number] {
  const sx = width / sourceWidth, sy = height / sourceHeight;
  const align = (preserve ?? "xMidYMid meet").trim().split(/\s+/u);
  if (align[0] === "none" && align.length === 1) return [sx, sy, 0, 0];
  const match = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/u.exec(align[0] ?? "");
  if (match === null || align.length > 2 || (align[1] !== undefined && align[1] !== "meet")) {
    return rejectImport("SVG_ASPECT_RATIO_UNSUPPORTED", location + ".preserveAspectRatio");
  }
  const scale = Math.min(sx, sy);
  const fraction = (name: string) => name === "Min" ? 0 : name === "Mid" ? 0.5 : 1;
  return [scale, scale, fraction(match[1]!) * (width - scale * sourceWidth),
    fraction(match[2]!) * (height - scale * sourceHeight)];
}

function viewport(root: Node): { width: number; height: number; matrix: Matrix } {
  const attrs = root.attributes;
  const units = new Map([["", 0.75], ["px", 0.75], ["pt", 1], ["in", 72], ["mm", 72 / 25.4], ["cm", 72 / 2.54]]);
  const length = (name: "width" | "height") => {
    const token = /^([+.\dEe-]+)(px|pt|in|mm|cm)?$/u.exec(attrs[name]?.trim() ?? "");
    if (token === null) return rejectImport("SVG_VIEWPORT_LENGTH_UNSUPPORTED", "svg." + name);
    const points = parseSvgNumber(token[1]!, "svg." + name) * units.get(token[2] ?? "")!;
    if (points <= 0 || points > 12_000) return rejectImport("SVG_VIEWPORT_LIMIT", "svg." + name);
    return points;
  };
  const width = length("width"), height = length("height");
  let view: Matrix = [0.75, 0, 0, -0.75, 0, height];
  if (attrs.viewBox !== undefined) {
    const box = svgNumberList(attrs.viewBox, "svg.viewBox");
    if (box.length !== 4 || box[2]! <= 0 || box[3]! <= 0) return rejectImport("SVG_INVALID_VIEWBOX", "svg.viewBox");
    const [x, y, w, h] = box as [number, number, number, number];
    const [sx, sy, dx, dy] = aspectFit(width, height, w, h, attrs.preserveAspectRatio, "svg");
    view = [sx, 0, 0, -sy, dx - x * sx, height - dy + y * sy];
  } else if (attrs.preserveAspectRatio !== undefined) {
    rejectImport("SVG_ASPECT_RATIO_UNSUPPORTED", "svg.preserveAspectRatio");
  }
  return { width, height, matrix: view };
}

function ipeChannel(value: number): number {
  return Math.floor(value * 1000 + 1e-9) / 1000;
}

// Match the precision of Ipe 7.2 XML output before creating persistent IDs.
function ipeNumber(value: number): string {
  return String(Number(Number(value.toFixed(8)).toPrecision(6)));
}

function paint(value: string, location: string): string | undefined {
  const color = value.trim().toLowerCase();
  if (color === "none") return undefined;
  if (/^url\s*\(/u.test(color)) return rejectImport("SVG_PAINT_SERVER_UNSUPPORTED", location);
  const rgb = /^rgb\(([^()]*)\)$/u.exec(color);
  if (rgb !== null) {
    const values = svgNumberList(rgb[1]!, location);
    if (values.length !== 3 || values.some((channel) => channel < 0 || channel > 255)) return rejectImport("SVG_COLOR_UNSUPPORTED", location);
    return values.map((channel) => ipeChannel(channel / 255)).join(" ");
  }
  let hex = named.get(color) ?? (/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/u.test(color) ? color.slice(1) : "");
  if (hex.length === 3) hex = [...hex].map((char) => char + char).join("");
  if (hex.length !== 6) return rejectImport("SVG_COLOR_UNSUPPORTED", location);
  return [0, 2, 4].map((index) => ipeChannel(parseInt(hex.slice(index, index + 2), 16) / 255)).join(" ");
}

function inherited(node: Node, parent: Attributes): Attributes {
  const style = { ...parent };
  for (const [key, value] of Object.entries(node.attributes)) if (styleKeys.has(key)) style[key] = value;
  if (node.attributes.style !== undefined) {
    for (const rule of node.attributes.style.split(";").map((item) => item.trim()).filter(Boolean)) {
      const pair = /^([a-z-]+)\s*:\s*(.+)$/u.exec(rule);
      if (pair === null || !styleKeys.has(pair[1]!)) rejectImport("SVG_STYLE_UNSUPPORTED", node.location);
      style[pair[1]!] = pair[2]!.trim();
    }
  }
  if (style.opacity !== undefined && style.opacity.trim() !== "1") rejectImport("SVG_OPACITY_UNSUPPORTED", node.location);
  for (const property of ["fill", "stroke"] as const) {
    if (node.attributes[property] !== undefined) paint(node.attributes[property], node.location);
    if (style[property] !== undefined) paint(style[property], node.location);
  }
  if ((style["stroke-linecap"] !== undefined && !Object.hasOwn(cap, style["stroke-linecap"]))
    || (style["stroke-linejoin"] !== undefined && !Object.hasOwn(join, style["stroke-linejoin"]))) rejectImport("SVG_STROKE_UNSUPPORTED", node.location);
  if (style["stroke-width"] !== undefined && parseSvgNumber(style["stroke-width"].trim(), node.location) <= 0) {
    rejectImport("SVG_STROKE_UNSUPPORTED", node.location);
  }
  if (style["fill-rule"] !== undefined && style["fill-rule"] !== "nonzero" && style["fill-rule"] !== "evenodd") {
    rejectImport("SVG_FILL_RULE_UNSUPPORTED", node.location);
  }
  return style;
}

function dimensions(spec: Node): PathSpec {
  const { attributes: a, location } = spec;
  const n = (name: string, fallback?: number): number => {
    const source = a[name];
    if (source === undefined && fallback !== undefined) return fallback;
    return parseSvgNumber(source?.trim() ?? "", location + "." + name);
  };
  const point = (x: string, y: string) => ({ x: n(x, 0), y: n(y, 0) });
  switch (spec.name) {
    case "path": return { kind: "raw", subpaths: parseSvgPath(a.d ?? "", location) };
    case "rect": {
      const width = n("width"), height = n("height"), x = n("x", 0), y = n("y", 0);
      if (width <= 0 || height <= 0) return rejectImport("SVG_EMPTY_GEOMETRY", location);
      const rx = n("rx", a.ry === undefined ? 0 : n("ry")), ry = n("ry", rx);
      if (rx < 0 || ry < 0) return rejectImport("SVG_INVALID_RADIUS", location);
      if (rx === 0 || ry === 0) return { kind: "rectangle", x, y, width, height };
      if (rx === ry && rx <= Math.min(width, height) / 2) return { kind: "rounded-rectangle", x, y, width, height, radius: rx };
      return rejectImport("SVG_ELLIPTICAL_RECT_CORNER_UNSUPPORTED", location);
    }
    case "circle": return { kind: "circle", center: point("cx", "cy"), radius: n("r") };
    case "ellipse": return { kind: "ellipse", center: point("cx", "cy"), rx: n("rx"), ry: n("ry") };
    case "line": return { kind: "segment", from: point("x1", "y1"), to: point("x2", "y2") };
    case "polyline":
    case "polygon": {
      const values = svgNumberList(a.points ?? "", location);
      if (values.length % 2 !== 0) return rejectImport("SVG_INVALID_POINTS", location);
      const points = values.flatMap((x, index) => index % 2 === 0 ? [{ x, y: values[index + 1]! }] : []);
      return { kind: spec.name, points };
    }
    default: return rejectImport("SVG_ELEMENT_UNSUPPORTED", location);
  }
}

interface ImportOutput {
  objects: string[];
  document: DocumentIR;
  decodedPixels: number;
}

const PNG_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const MAX_IMAGE_PIXELS = 1_000_000;

function embeddedPng(href: string | undefined, location: string): Buffer {
  const prefix = "data:image/png;base64,";
  if (href === undefined || !href.startsWith(prefix)) return rejectImport("SVG_IMAGE_REFERENCE_UNSUPPORTED", location);
  const encoded = href.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length < 33
    || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return rejectImport("SVG_INVALID_PNG", location);
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    return rejectImport("SVG_INVALID_PNG", location);
  }
  if (bytes[24]! > 8) return rejectImport("SVG_PNG_BIT_DEPTH_UNSUPPORTED", location);
  // pngjs does not cap inflated output for interlaced PNGs.
  if (bytes[28] !== 0) return rejectImport("SVG_PNG_INTERLACE_UNSUPPORTED", location);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    offset += length + 12;
    if (offset > bytes.length) return rejectImport("SVG_INVALID_PNG", location);
    if (!PNG_CHUNKS.has(type)) return rejectImport("SVG_PNG_CHUNK_UNSUPPORTED", location);
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) return rejectImport("SVG_INVALID_PNG", location);
      return bytes;
    }
  }
  return rejectImport("SVG_INVALID_PNG", location);
}

function renderImage(node: Node, matrix: Matrix, output: ImportOutput): void {
  const { attributes: a, location } = node;
  const bytes = embeddedPng(a.href, location);
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (pixels > MAX_IMAGE_PIXELS - output.decodedPixels) rejectImport("SVG_IMAGE_PIXEL_LIMIT", location);
  const x = parseSvgNumber(a.x ?? "0", location), y = parseSvgNumber(a.y ?? "0", location);
  const width = parseSvgNumber(a.width ?? "", location), height = parseSvgNumber(a.height ?? "", location);
  if (width <= 0 || height <= 0) rejectImport("SVG_INVALID_IMAGE_BOUNDS", location);
  try {
    const { asset, info } = addBitmapAsset(output.document, bytes, "image/png", { maxPixels: MAX_IMAGE_PIXELS });
    output.decodedPixels += pixels;
    const [sx, sy, dx, dy] = aspectFit(width, height, info.width, info.height, a.preserveAspectRatio, location);
    const left = x + dx, top = y + dy, right = left + sx * info.width, bottom = top + sy * info.height;
    // Ipe draws the first raster row at the larger local y coordinate.
    const placement = composed(matrix, [1, 0, 0, -1, 0, top + bottom], location);
    const rounded = placement.map((value) => Number(ipeNumber(value))) as unknown as Matrix;
    assertInvertibleMatrix(rounded);
    const rect = [left, top, right, bottom].map(ipeNumber);
    if (rect[0] === rect[2] || rect[1] === rect[3]) rejectImport("SVG_INVALID_IMAGE_BOUNDS", location);
    output.objects.push('<image layer="import" bitmap="' + asset.xml!.attributes!.id + '" matrix="' + rounded.join(" ")
      + '" rect="' + rect.join(" ") + '"/>');
  } catch (error) {
    if (error instanceof VectorImportError) throw error;
    rejectImport("SVG_INVALID_PNG_OR_PLACEMENT", location);
  }
}

function renderObjects(node: Node, parent: Matrix, parentStyle: Attributes, output: ImportOutput): void {
  const { location, name, attributes } = node;
  const allowed: readonly string[] = name === "svg" ? ["width", "height", "viewBox", "preserveAspectRatio", "version"]
    : name === "g" ? [] : geometry[name as keyof typeof geometry];
  for (const key of Object.keys(attributes)) {
    if (key === "clip-path" || key === "mask" || key === "filter") rejectImport("SVG_EFFECT_UNSUPPORTED", location);
    if (key !== "id" && key !== "transform" && key !== "style" && !styleKeys.has(key) && !allowed.includes(key)) {
      rejectImport("SVG_ATTRIBUTE_UNSUPPORTED", location);
    }
  }
  if (name === "svg" && attributes.transform !== undefined) rejectImport("SVG_ROOT_TRANSFORM_UNSUPPORTED", location);
  const matrix = composed(parent, transform(attributes.transform, location), location);
  const computed = inherited(node, parentStyle);
  if (name === "svg" || name === "g") {
    for (const child of node.children) renderObjects(child, matrix, computed, output);
    return;
  }
  if (node.children.length !== 0) rejectImport("SVG_NESTED_GEOMETRY_UNSUPPORTED", location);

  if (name === "image") {
    renderImage(node, matrix, output);
    return;
  }

  const fill = name === "line" ? undefined : paint(computed.fill ?? "black", location);
  const stroke = paint(computed.stroke ?? "none", location);
  if (fill === undefined && stroke === undefined) rejectImport("SVG_INVISIBLE_GEOMETRY_UNSUPPORTED", location);
  const fillrule = computed["fill-rule"] ?? "nonzero";
  if (fillrule !== "nonzero" && fillrule !== "evenodd") rejectImport("SVG_FILL_RULE_UNSUPPORTED", location);
  const style: PathStyle = { ...(fill === undefined ? {} : { fill, fillrule: fillrule === "evenodd" ? "evenodd" : "wind" }) };
  if (stroke !== undefined) {
    const width = parseSvgNumber(computed["stroke-width"]?.trim() ?? "1", location + ".stroke-width");
    const lineCap = computed["stroke-linecap"] ?? "butt", lineJoin = computed["stroke-linejoin"] ?? "miter";
    if (width <= 0 || !Object.hasOwn(cap, lineCap) || !Object.hasOwn(join, lineJoin)) rejectImport("SVG_STROKE_UNSUPPORTED", location);
    const [a, b, c, d] = matrix;
    const xScale = Math.hypot(a, b), yScale = Math.hypot(c, d);
    if (Math.abs(xScale - yScale) > 1e-9 * Math.max(xScale, yScale)
      || Math.abs(a * c + b * d) > 1e-9 * xScale * yScale) rejectImport("SVG_AFFINE_STROKE_UNSUPPORTED", location);
    // Ipe pens are in page units, independent of object matrix scale.
    Object.assign(style, { stroke, pen: Number(ipeNumber(width * xScale)), cap: cap[lineCap as keyof typeof cap], join: join[lineJoin as keyof typeof join] });
  }

  const spec = dimensions(node);
  try {
    const xml = compilePath({ ...spec, style });
    const attrs = Object.entries(xml.attributes ?? {}).map(([key, value]) => " " + key + '="' + value + '"').join("");
    const text = xml.children?.[0];
    if (text?.type !== "text") rejectImport("SVG_GEOMETRY_UNSUPPORTED", location);
    const rounded = matrix.map((value) => Number(ipeNumber(value))) as unknown as Matrix;
    assertInvertibleMatrix(rounded);
    const coordinates = text.text.trim().split(/\s+/u).map((token) => /^[a-zA-Z]$/u.test(token) ? token : ipeNumber(Number(token)));
    output.objects.push('<path layer="import" matrix="' + rounded.join(" ") + '"' + attrs + ">" + coordinates.join(" ") + "</path>");
  } catch (error) {
    if (error instanceof VectorImportError) throw error;
    rejectImport("SVG_INVALID_GEOMETRY", location);
  }
}

export function importSvg(input: Uint8Array): IpeDocument {
  const root = parseTree(input);
  const { width, height, matrix } = viewport(root);
  try {
    assertDomainNumber(width, "SVG width"); assertDomainNumber(height, "SVG height"); assertInvertibleMatrix(matrix);
  } catch { rejectImport("SVG_VIEWPORT_LIMIT", "svg"); }
  const output: ImportOutput = { objects: [], document: { schemaVersion: IR_SCHEMA_VERSION, format: IPE_FORMAT_VERSION, pages: [] }, decodedPixels: 0 };
  renderObjects(root, matrix, {}, output);
  if (output.objects.length === 0) rejectImport("SVG_EMPTY_DOCUMENT", "svg");
  const bitmaps = (output.document.assets ?? []).map((asset) => {
    const attributes = Object.entries(asset.xml!.attributes!).map(([key, value]) => " " + key + '="' + value + '"').join("");
    return "<bitmap" + attributes + ">" + asset.data + "</bitmap>";
  });
  const paper = ipeNumber(width) + " " + ipeNumber(height);
  const document = ipeDocumentCodec.parse('<ipe version="70218"><ipestyle name="svg-import"><layout paper="' + paper
    + '" origin="0 0" frame="' + paper + '"/></ipestyle>' + bitmaps.join("\n")
    + '<page><layer name="import"/><view layers="import" active="import"/>'
    + output.objects.join("\n") + "</page></ipe>");
  checkDocumentShapeLimits(document);
  if (ipeDocumentCodec.validate(document).some(({ severity }) => severity === "error")) rejectImport("SVG_IPE_VALIDATION_FAILED", "svg");
  return document;
}
