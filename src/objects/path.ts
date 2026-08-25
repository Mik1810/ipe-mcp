import { assertDomainNumber } from "../domain/numeric.js";
import { assertValidXml10String } from "../domain/xml-chars.js";
import type { XmlElement } from "../domain/xml-node.js";

export interface PathPoint { readonly x: number; readonly y: number }

export interface PathStyle {
  readonly stroke?: string;
  readonly fill?: string;
  readonly pen?: string;
  readonly dash?: string;
  readonly cap?: "0" | "1" | "2";
  readonly join?: "0" | "1" | "2";
  readonly fillrule?: "wind" | "evenodd" | "eofill";
  readonly opacity?: string;
  readonly strokeOpacity?: string;
  readonly gradient?: string;
  readonly tiling?: string;
  readonly farrow?: boolean;
  readonly rarrow?: boolean;
  readonly farrowsize?: string;
  readonly rarrowsize?: string;
  readonly farrowshape?: string;
  readonly rarrowshape?: string;
}

interface Styled { readonly style?: PathStyle }

export interface PointPath extends Styled { readonly kind: "point"; readonly point: PathPoint }
export interface SegmentPath extends Styled { readonly kind: "segment"; readonly from: PathPoint; readonly to: PathPoint }
export interface PolylinePath extends Styled { readonly kind: "polyline"; readonly points: readonly PathPoint[] }
export interface PolygonPath extends Styled { readonly kind: "polygon"; readonly points: readonly PathPoint[] }
export interface RectanglePath extends Styled { readonly kind: "rectangle"; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface RoundedRectanglePath extends Styled { readonly kind: "rounded-rectangle"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius: number }
export interface CirclePath extends Styled { readonly kind: "circle"; readonly center: PathPoint; readonly radius: number }
export interface EllipsePath extends Styled { readonly kind: "ellipse"; readonly center: PathPoint; readonly rx: number; readonly ry: number; readonly rotationDegrees?: number }
export interface ArcPath extends Styled {
  readonly kind: "arc";
  readonly center: PathPoint;
  readonly rx: number;
  readonly ry: number;
  readonly rotationDegrees?: number;
  readonly startAngleDegrees: number;
  readonly endAngleDegrees: number;
  readonly direction: "ccw" | "cw";
}
export interface QuadraticPath extends Styled { readonly kind: "quadratic"; readonly from: PathPoint; readonly control: PathPoint; readonly to: PathPoint }
export interface CubicPath extends Styled { readonly kind: "cubic"; readonly from: PathPoint; readonly control1: PathPoint; readonly control2: PathPoint; readonly to: PathPoint }
export interface UniformPath extends Styled { readonly kind: "uniform"; readonly points: readonly PathPoint[]; readonly closed?: boolean }
export interface CardinalPath extends Styled { readonly kind: "cardinal"; readonly points: readonly PathPoint[]; readonly closed?: boolean; readonly tension?: number }
export interface CatmullRomPath extends Styled { readonly kind: "catmull-rom"; readonly points: readonly PathPoint[]; readonly closed?: boolean; readonly tension?: number }
export interface ClothoidPath extends Styled { readonly kind: "clothoid"; readonly points: readonly PathPoint[]; readonly closed?: boolean }

export type RawPathCommand =
  | { readonly op: "m" | "l"; readonly point: PathPoint }
  | { readonly op: "c"; readonly control1: PathPoint; readonly control2: PathPoint; readonly to: PathPoint }
  | { readonly op: "h" }
  | { readonly op: "e"; readonly matrix: readonly [number, number, number, number, number, number] }
  | { readonly op: "a"; readonly matrix: readonly [number, number, number, number, number, number]; readonly to: PathPoint }
  | { readonly op: "c"; readonly points: readonly PathPoint[] }
  | { readonly op: "s" | "u" | "L"; readonly points: readonly PathPoint[] }
  | { readonly op: "C"; readonly points: readonly PathPoint[]; readonly tension: number };

export interface RawSubpath { readonly commands: readonly RawPathCommand[]; readonly closed?: boolean }
export interface RawPath extends Styled { readonly kind: "raw"; readonly subpaths: readonly RawSubpath[] }
export interface CompoundPath extends Styled { readonly kind: "compound"; readonly subpaths: readonly PathSpec[] }

export type PathSpec = PointPath | SegmentPath | PolylinePath | PolygonPath | RectanglePath | RoundedRectanglePath
  | CirclePath | EllipsePath | ArcPath | QuadraticPath | CubicPath | UniformPath | CardinalPath | CatmullRomPath
  | ClothoidPath | RawPath | CompoundPath;

export interface PathMetadata {
  readonly closed: boolean;
  readonly commandCount: number;
  readonly start?: PathPoint;
  readonly end?: PathPoint;
}

export interface CompiledPath { readonly xml: XmlElement; readonly subpaths: readonly PathMetadata[] }

type Matrix = readonly [number, number, number, number, number, number];
type Command = RawPathCommand;
interface BuiltSubpath { readonly commands: readonly Command[]; readonly closed: boolean }

const number = (value: number, label: string): string => {
  assertDomainNumber(value, label);
  return Object.is(value, -0) ? "0" : String(value);
};

function point(value: PathPoint, label: string): void {
  if (!value || typeof value.x !== "number" || typeof value.y !== "number") throw new Error(`${label} must be a point`);
  assertDomainNumber(value.x, `${label}.x`);
  assertDomainNumber(value.y, `${label}.y`);
}

function same(a: PathPoint, b: PathPoint): boolean { return a.x === b.x && a.y === b.y }
function distinctAdjacent(points: readonly PathPoint[], label: string): void {
  points.forEach((p, i) => point(p, `${label}[${i}]`));
  for (let i = 1; i < points.length; i += 1) if (same(points[i - 1]!, points[i]!)) throw new Error(`${label} has adjacent duplicate points`);
}
function requireCount(points: readonly PathPoint[], count: number, label: string): void {
  if (points.length < count) throw new Error(`${label} requires at least ${count} points`);
  distinctAdjacent(points, label);
}
function area(points: readonly PathPoint[]): number {
  return points.reduce((sum, p, i) => sum + p.x * points[(i + 1) % points.length]!.y - p.y * points[(i + 1) % points.length]!.x, 0) / 2;
}
function matrix(a: Matrix, label: string): void { a.forEach((v, i) => assertDomainNumber(v, `${label}[${i}]`)); }
function radians(degrees: number, label: string): number { assertDomainNumber(degrees, label); return degrees * Math.PI / 180; }
function matrixPoint(a: Matrix, t: number): PathPoint {
  const x = a[0] * Math.cos(t) + a[2] * Math.sin(t) + a[4];
  const y = a[1] * Math.cos(t) + a[3] * Math.sin(t) + a[5];
  return { x: Math.abs(x) < 1e-12 ? 0 : x, y: Math.abs(y) < 1e-12 ? 0 : y };
}

function styleAttributes(style: PathStyle | undefined): Record<string, string> {
  if (!style) return {};
  if (style.gradient !== undefined && style.tiling !== undefined) throw new Error("gradient and tiling are mutually exclusive");
  if ((style.gradient !== undefined || style.tiling !== undefined) && style.fill === undefined) throw new Error("gradient or tiling requires fill");
  const attrs: Record<string, string> = {};
  const strings: Array<[string, string | undefined]> = [
    ["stroke", style.stroke], ["fill", style.fill], ["pen", style.pen], ["dash", style.dash], ["cap", style.cap], ["join", style.join],
    ["gradient", style.gradient], ["tiling", style.tiling], ["opacity", style.opacity], ["stroke-opacity", style.strokeOpacity],
  ];
  for (const [name, value] of strings) if (value !== undefined) { assertValidXml10String(value); attrs[name] = value; }
  if (style.pen !== undefined) {
    const pen = Number(style.pen);
    if (!Number.isFinite(pen) || pen < 0) throw new Error("path pen must be finite and non-negative");
  }
  if (style.dash !== undefined && style.dash.startsWith("[")) {
    if (!/^\[(?:\s*\d+(?:\.\d+)?)+(?:\s*)\]\s+\d+(?:\.\d+)?$/u.test(style.dash)) {
      throw new Error("path dash must use Ipe/PDF dash syntax");
    }
  } else if (style.dash !== undefined && !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(style.dash)) {
    throw new Error("path dash must be a style name or Ipe/PDF dash syntax");
  }
  if (style.fillrule !== undefined) attrs.fillrule = style.fillrule === "evenodd" ? "eofill" : style.fillrule;
  if (style.farrow) attrs.arrow = `${style.farrowshape ?? "normal"}/${style.farrowsize ?? "normal"}`;
  if (style.rarrow) attrs.rarrow = `${style.rarrowshape ?? "normal"}/${style.rarrowsize ?? "normal"}`;
  return attrs;
}

function commandsText(commands: readonly Command[]): string {
  const tokens: string[] = [];
  for (const command of commands) {
    switch (command.op) {
      case "m": case "l": tokens.push(number(command.point.x, "point.x"), number(command.point.y, "point.y"), command.op); break;
      case "c":
        if ("points" in command) {
          for (const p of command.points) tokens.push(number(p.x, "spline.x"), number(p.y, "spline.y"));
          tokens.push("c");
        } else {
          tokens.push(number(command.control1.x, "control1.x"), number(command.control1.y, "control1.y"), number(command.control2.x, "control2.x"), number(command.control2.y, "control2.y"), number(command.to.x, "to.x"), number(command.to.y, "to.y"), "c");
        }
        break;
      case "h": tokens.push("h"); break;
      case "e": tokens.push(...command.matrix.map((v, i) => number(v, `matrix[${i}]`)), "e"); break;
      case "a": tokens.push(...command.matrix.map((v, i) => number(v, `matrix[${i}]`)), number(command.to.x, "arc.to.x"), number(command.to.y, "arc.to.y"), "a"); break;
      case "s": case "u": case "L": for (const p of command.points) tokens.push(number(p.x, "spline.x"), number(p.y, "spline.y")); tokens.push(command.op); break;
      case "C":
        for (const p of command.points) tokens.push(number(p.x, "spline.x"), number(p.y, "spline.y"));
        tokens.push(number(command.tension, "cardinal tension"), "C");
        break;
    }
  }
  return tokens.join(" ");
}

function validateRawSubpath(subpath: RawSubpath, index: number): BuiltSubpath {
  if (!subpath || typeof subpath !== "object" || !Array.isArray(subpath.commands)) throw new Error(`raw subpath[${index}] commands must be an array`);
  if (subpath.closed !== undefined && typeof subpath.closed !== "boolean") throw new Error(`raw subpath[${index}].closed must be boolean`);
  if (subpath.commands.length === 0) throw new Error(`raw subpath[${index}] is empty`);
  let started = false; let closed = subpath.closed ?? false;
  for (const [ci, command] of subpath.commands.entries()) {
    assertRawCommand(command, index, ci);
    if (command.op === "m") { if (started) throw new Error(`raw subpath[${index}] has multiple starts`); started = true; point(command.point, `raw[${index}][${ci}].point`); }
    else if (command.op === "e" || command.op === "u") {
      if (started) throw new Error(`${command.op} must start a raw subpath`);
      started = true;
      if (command.op === "e") { matrix(command.matrix, "raw ellipse matrix"); closed = true; }
      else { requireCount(command.points, 3, "raw closed spline"); closed = true; }
      if (ci !== subpath.commands.length - 1) throw new Error(`${command.op} must be the only raw subpath command`);
    }
    else if (!started) throw new Error(`raw subpath[${index}] must start with move or a standalone shape operator`);
    else if (command.op === "l") point(command.point, `raw[${index}][${ci}].point`);
    else if (command.op === "c") {
      if ("points" in command) requireCount(command.points, 2, "raw uniform spline");
      else { point(command.control1, "raw.control1"); point(command.control2, "raw.control2"); point(command.to, "raw.to"); }
    }
    else if (command.op === "h") { if (ci !== subpath.commands.length - 1) throw new Error("close must be the final raw command"); closed = true; }
    else if (command.op === "a") { matrix(command.matrix, "raw arc matrix"); point(command.to, "raw arc endpoint"); }
    else if (command.op === "s") requireCount(command.points, 2, "raw old-style spline");
    else if (command.op === "C") {
      requireCount(command.points, 2, "raw cardinal spline");
      assertDomainNumber(command.tension, "raw cardinal tension");
      if (command.tension < 0 || command.tension > 10) throw new Error("raw cardinal tension must be in [0,10]");
    }
    else if (command.op === "L") requireCount(command.points, 1, "raw clothoid spline");
  }
  if (!started) throw new Error(`raw subpath[${index}] has no start`);
  const last = subpath.commands.at(-1);
  const needsClose = subpath.closed === true && last?.op !== "h" && last?.op !== "e" && last?.op !== "u";
  return { commands: needsClose ? [...subpath.commands, { op: "h" }] : subpath.commands, closed: closed || needsClose };
}

function assertRawCommand(command: unknown, subpathIndex: number, commandIndex: number): asserts command is RawPathCommand {
  const label = `raw[${subpathIndex}][${commandIndex}]`;
  if (!command || typeof command !== "object" || typeof (command as { op?: unknown }).op !== "string") throw new Error(`${label} has an invalid command discriminant`);
  const op = (command as { op: string }).op;
  const allowed: Readonly<Record<string, readonly string[]>> = {
    m: ["op", "point"], l: ["op", "point"], h: ["op"], e: ["op", "matrix"], a: ["op", "matrix", "to"],
    c: ["op", "points"], s: ["op", "points"], u: ["op", "points"], L: ["op", "points"], C: ["op", "points", "tension"],
  };
  if (!(op in allowed)) throw new Error(`${label} has unknown command '${op}'`);
  const keys = Object.keys(command);
  const expected = allowed[op]!;
  if (op === "c" && !keys.includes("points")) {
    const cubic = ["op", "control1", "control2", "to"];
    if (keys.some((key) => !cubic.includes(key)) || keys.length !== cubic.length) throw new Error(`${label} cubic command has invalid fields`);
    point((command as { control1: PathPoint }).control1, `${label}.control1`);
    point((command as { control2: PathPoint }).control2, `${label}.control2`);
    point((command as { to: PathPoint }).to, `${label}.to`);
    return;
  }
  if (keys.some((key) => !expected.includes(key)) || keys.length !== expected.length) throw new Error(`${label} has invalid fields for '${op}'`);
  if (op === "m" || op === "l") point((command as { point: PathPoint }).point, `${label}.point`);
  if (op === "e" || op === "a") {
    const value = (command as { matrix: Matrix }).matrix;
    if (!Array.isArray(value) || value.length !== 6) throw new Error(`${label}.matrix must contain six finite numbers`);
    matrix(value, `${label}.matrix`);
  }
  if (op === "a") point((command as { to: PathPoint }).to, `${label}.to`);
  if (op === "c" || op === "s" || op === "u" || op === "L" || op === "C") {
    const points = (command as { points: unknown }).points;
    if (!Array.isArray(points)) throw new Error(`${label}.points must be an array`);
    points.forEach((value, index) => point(value as PathPoint, `${label}.points[${index}]`));
  }
  if (op === "C") assertDomainNumber((command as { tension: number }).tension, `${label}.tension`);
}

function ellipseMatrix(center: PathPoint, rx: number, ry: number, rotationDegrees = 0, direction: "ccw" | "cw" = "ccw"): Matrix {
  point(center, "center");
  if (!(rx > 0) || !(ry > 0)) throw new Error("ellipse radii must be positive");
  const theta = radians(rotationDegrees, "rotationDegrees"); const c = Math.cos(theta); const s = Math.sin(theta);
  return [rx * c, rx * s, direction === "ccw" ? -ry * s : ry * s, direction === "ccw" ? ry * c : -ry * c, center.x, center.y];
}

function primitive(spec: Exclude<PathSpec, CompoundPath | RawPath>): BuiltSubpath[] {
  switch (spec.kind) {
    case "point": point(spec.point, "point"); return [{ commands: [{ op: "m", point: spec.point }, { op: "l", point: spec.point }], closed: false }];
    case "segment": point(spec.from, "from"); point(spec.to, "to"); if (same(spec.from, spec.to)) throw new Error("segment endpoints must differ"); return [{ commands: [{ op: "m", point: spec.from }, { op: "l", point: spec.to }], closed: false }];
    case "polyline": requireCount(spec.points, 2, "polyline"); return [{ commands: [{ op: "m", point: spec.points[0]! }, ...spec.points.slice(1).map((p) => ({ op: "l" as const, point: p }))], closed: false }];
    case "polygon": requireCount(spec.points, 3, "polygon"); if (Math.abs(area(spec.points)) < 1e-18) throw new Error("polygon is degenerate"); return [{ commands: [{ op: "m", point: spec.points[0]! }, ...spec.points.slice(1).map((p) => ({ op: "l" as const, point: p })), { op: "h" }], closed: true }];
    case "rectangle": if (!(spec.width > 0) || !(spec.height > 0)) throw new Error("rectangle dimensions must be positive"); point({ x: spec.x, y: spec.y }, "rectangle origin"); point({ x: spec.x + spec.width, y: spec.y + spec.height }, "rectangle extent"); return [{ commands: [{ op: "m", point: { x: spec.x, y: spec.y } }, { op: "l", point: { x: spec.x + spec.width, y: spec.y } }, { op: "l", point: { x: spec.x + spec.width, y: spec.y + spec.height } }, { op: "l", point: { x: spec.x, y: spec.y + spec.height } }, { op: "h" }], closed: true }];
    case "rounded-rectangle": {
      if (!(spec.width > 0) || !(spec.height > 0)) throw new Error("rounded rectangle dimensions must be positive");
      point({ x: spec.x, y: spec.y }, "rounded rectangle origin"); if (!(spec.radius > 0) || spec.radius > Math.min(spec.width, spec.height) / 2) throw new Error("rounded rectangle radius is out of range");
      const { x, y, width: w, height: h, radius: r } = spec;
      const cmds: Command[] = [{ op: "m", point: { x: x + r, y } }, { op: "l", point: { x: x + w - r, y } }, { op: "a", matrix: [r, 0, 0, r, x + w - r, y + r], to: { x: x + w, y: y + r } }, { op: "l", point: { x: x + w, y: y + h - r } }, { op: "a", matrix: [r, 0, 0, r, x + w - r, y + h - r], to: { x: x + w - r, y: y + h } }, { op: "l", point: { x: x + r, y: y + h } }, { op: "a", matrix: [r, 0, 0, r, x + r, y + h - r], to: { x, y: y + h - r } }, { op: "l", point: { x, y: y + r } }, { op: "a", matrix: [r, 0, 0, r, x + r, y + r], to: { x: x + r, y } }, { op: "h" }];
      return [{ commands: cmds, closed: true }];
    }
    case "circle": return [{ commands: [{ op: "e", matrix: ellipseMatrix(spec.center, spec.radius, spec.radius) }], closed: true }];
    case "ellipse": return [{ commands: [{ op: "e", matrix: ellipseMatrix(spec.center, spec.rx, spec.ry, spec.rotationDegrees) }], closed: true }];
    case "arc": {
      const start = radians(spec.startAngleDegrees, "startAngleDegrees"); const end = radians(spec.endAngleDegrees, "endAngleDegrees");
      if (spec.startAngleDegrees === spec.endAngleDegrees || Math.abs(spec.endAngleDegrees - spec.startAngleDegrees) >= 360) throw new Error("arc span must be non-zero and less than 360 degrees");
      const m = ellipseMatrix(spec.center, spec.rx, spec.ry, spec.rotationDegrees, spec.direction);
      const parameterSign = spec.direction === "ccw" ? 1 : -1;
      return [{ commands: [{ op: "m", point: matrixPoint(m, parameterSign * start) }, { op: "a", matrix: m, to: matrixPoint(m, parameterSign * end) }], closed: false }];
    }
    case "quadratic": {
      point(spec.from, "quadratic.from"); point(spec.control, "quadratic.control"); point(spec.to, "quadratic.to");
      const c1 = { x: spec.from.x + (2 / 3) * (spec.control.x - spec.from.x), y: spec.from.y + (2 / 3) * (spec.control.y - spec.from.y) };
      const c2 = { x: spec.to.x + (2 / 3) * (spec.control.x - spec.to.x), y: spec.to.y + (2 / 3) * (spec.control.y - spec.to.y) };
      return [{ commands: [{ op: "m", point: spec.from }, { op: "c", control1: c1, control2: c2, to: spec.to }], closed: false }];
    }
    case "cubic": point(spec.from, "cubic.from"); point(spec.control1, "cubic.control1"); point(spec.control2, "cubic.control2"); point(spec.to, "cubic.to"); if (same(spec.from, spec.to) && same(spec.control1, spec.from) && same(spec.control2, spec.from)) throw new Error("cubic is degenerate"); return [{ commands: [{ op: "m", point: spec.from }, { op: "c", control1: spec.control1, control2: spec.control2, to: spec.to }], closed: false }];
    case "uniform":
      requireCount(spec.points, 3, "uniform spline");
      return spec.closed
        ? [{ commands: [{ op: "u", points: spec.points }], closed: true }]
        : [{ commands: [{ op: "m", point: spec.points[0]! }, { op: "c", points: spec.points.slice(1) }], closed: false }];
    case "cardinal": {
      requireCount(spec.points, 3, "cardinal spline");
      if (spec.closed) throw new Error("closed cardinal splines are not representable by Ipe's C operator");
      const tension = spec.tension ?? 0.5;
      assertDomainNumber(tension, "cardinal tension");
      if (tension < 0 || tension > 10) throw new Error("cardinal tension must be in [0,10]");
      return [{ commands: [{ op: "m", point: spec.points[0]! }, { op: "C", points: spec.points.slice(1), tension }], closed: false }];
    }
    case "catmull-rom": {
      requireCount(spec.points, 3, "Catmull-Rom spline");
      if (spec.closed) throw new Error("closed Catmull-Rom splines are not representable by Ipe's C operator");
      const tension = spec.tension ?? 0.5;
      assertDomainNumber(tension, "Catmull-Rom tension");
      if (tension !== 0.5) throw new Error("Catmull-Rom tension must be 0.5");
      return [{ commands: [{ op: "m", point: spec.points[0]! }, { op: "C", points: spec.points.slice(1), tension }], closed: false }];
    }
    case "clothoid":
      requireCount(spec.points, 2, "clothoid");
      if (spec.closed) throw new Error("closed clothoid splines are not representable by Ipe's L operator");
      return [{ commands: [{ op: "m", point: spec.points[0]! }, { op: "L", points: spec.points.slice(1) }], closed: false }];
    default:
      throw new Error(`unsupported path kind '${String((spec as { kind?: unknown }).kind)}'`);
  }
}

function build(spec: PathSpec): BuiltSubpath[] {
  if (!spec || typeof spec !== "object" || typeof (spec as { kind?: unknown }).kind !== "string") throw new Error("path spec has an invalid kind discriminant");
  if (spec.kind === "raw") {
    if (!Array.isArray(spec.subpaths)) throw new Error("raw path subpaths must be an array");
    return spec.subpaths.map(validateRawSubpath);
  }
  if (spec.kind === "compound") {
    if (!Array.isArray(spec.subpaths)) throw new Error("compound path subpaths must be an array");
    if (spec.subpaths.length === 0) throw new Error("compound path requires subpaths");
    const styledChild = (child: PathSpec): boolean => child.style !== undefined || (child.kind === "compound" && child.subpaths.some(styledChild));
    if (spec.subpaths.some(styledChild)) throw new Error("compound subpaths cannot carry styles; set style on the compound path");
    return spec.subpaths.flatMap(build);
  }
  return primitive(spec);
}

function metadata(subpaths: readonly BuiltSubpath[]): PathMetadata[] {
  return subpaths.map(({ commands, closed }) => {
    let start: PathPoint | undefined;
    let end: PathPoint | undefined;
    for (const command of commands) {
      if (command.op === "m") { start ??= command.point; end = command.point; }
      else if (command.op === "l") end = command.point;
      else if (command.op === "a") end = command.to;
      else if (command.op === "c") end = "points" in command ? command.points.at(-1) : command.to;
      else if (command.op === "s" || command.op === "u" || command.op === "C" || command.op === "L") end = command.points.at(-1);
    }
    return { closed, commandCount: commands.length, ...(start ? { start } : {}), ...(end ? { end } : {}) };
  });
}

export function compilePathResult(spec: PathSpec): CompiledPath {
  const subpaths = build(spec); const style = styleAttributes(spec.style);
  if (spec.kind === "point" && style.cap === undefined) style.cap = "1";
  const arrows = style.arrow !== undefined || style.rarrow !== undefined;
  if (arrows && (spec.kind === "point" || subpaths.length !== 1 || subpaths[0]!.closed || !subpaths[0]!.commands.some((c) => c.op === "l" || c.op === "c" || c.op === "a" || c.op === "s" || c.op === "u" || c.op === "C" || c.op === "L"))) throw new Error("arrows require one non-degenerate open subpath");
  const commands = subpaths.flatMap((subpath) => subpath.commands);
  return { xml: { type: "element", name: "path", attributes: style, children: [{ type: "text", text: commandsText(commands) }] }, subpaths: metadata(subpaths) };
}

export function compilePath(spec: PathSpec): XmlElement { return compilePathResult(spec).xml; }
