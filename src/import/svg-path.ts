import { assertDomainNumber } from "../domain/numeric.js";
import type { PathPoint, RawPathCommand, RawSubpath } from "../objects/path.js";
import { rejectImport } from "./errors.js";

const numericToken = /[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const COMMANDS = /^[MmZzLlHhVvCcSsQqTtAa]$/u;

export function parseSvgNumber(token: string, location: string): number {
  numericToken.lastIndex = 0;
  const match = numericToken.exec(token);
  if (match?.[0] !== token) return rejectImport("SVG_INVALID_NUMBER", location);
  const value = Number(token);
  try { assertDomainNumber(value, "SVG number"); }
  catch { rejectImport("SVG_NUMERIC_LIMIT", location); }
  return value;
}

function tokens(source: string, location: string, commands: boolean): string[] {
  const output: string[] = [];
  let cursor = 0;
  let comma = false, separated = true;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (/[ \t\r\n]/u.test(char)) { separated = true; cursor++; continue; }
    if (char === ",") {
      if (comma || output.length === 0 || COMMANDS.test(output.at(-1)!)) rejectImport("SVG_INVALID_SEPARATOR", location);
      comma = true; separated = true; cursor++; continue;
    }
    if (commands && COMMANDS.test(char)) {
      if (comma) rejectImport("SVG_INVALID_SEPARATOR", location);
      output.push(char); cursor++;
    } else {
      if (!commands && !separated) rejectImport("SVG_INVALID_SEPARATOR", location);
      numericToken.lastIndex = cursor;
      const match = numericToken.exec(source);
      if (match === null) rejectImport("SVG_INVALID_TOKEN", location);
      output.push(match[0]);
      cursor = numericToken.lastIndex;
      comma = false; separated = false;
    }
    if (output.length > 24_000) rejectImport("SVG_TOKEN_LIMIT", location);
  }
  if (comma) rejectImport("SVG_INVALID_SEPARATOR", location);
  return output;
}

export function svgNumberList(source: string, location: string): number[] {
  return tokens(source, location, false).map((value) => parseSvgNumber(value, location));
}

function blend(from: PathPoint, to: PathPoint, weight: number): PathPoint {
  return { x: from.x + (to.x - from.x) * weight, y: from.y + (to.y - from.y) * weight };
}

function reflected(origin: PathPoint, control: PathPoint): PathPoint {
  return { x: 2 * origin.x - control.x, y: 2 * origin.y - control.y };
}

function ellipseArc(
  from: PathPoint, to: PathPoint, rx0: number, ry0: number, degrees: number,
  large: boolean, sweep: boolean,
): RawPathCommand | undefined {
  if (from.x === to.x && from.y === to.y) return undefined;
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) return { op: "l", point: to };
  const phi = (degrees % 360) * Math.PI / 180;
  const cosine = Math.cos(phi), sine = Math.sin(phi);
  const dx = (from.x - to.x) / 2, dy = (from.y - to.y) / 2;
  const x = cosine * dx + sine * dy, y = -sine * dx + cosine * dy;
  const scale = Math.hypot(x / rx, y / ry);
  if (scale > 1) { rx *= scale; ry *= scale; }
  const norm = (x / rx) ** 2 + (y / ry) ** 2;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (1 - norm) / norm));
  const u = factor * rx * y / ry, v = -factor * ry * x / rx;
  const cx = (from.x + to.x) / 2 + cosine * u - sine * v;
  const cy = (from.y + to.y) / 2 + sine * u + cosine * v;
  const sign = sweep ? 1 : -1;
  return { op: "a", matrix: [rx * cosine, rx * sine, -sign * ry * sine, sign * ry * cosine, cx, cy], to };
}

export function parseSvgPath(data: string, location: string): RawSubpath[] {
  const input = tokens(data, location, true);
  const output: RawSubpath[] = [];
  let i = 0, command = "", previous = "";
  let point: PathPoint = { x: 0, y: 0 }, start = point, control = point;
  let part: RawPathCommand[] = [];
  const read = () => {
    const token = input[i++];
    if (token === undefined || COMMANDS.test(token)) rejectImport("SVG_PATH_ARITY", location);
    return parseSvgNumber(token, location);
  };
  const flag = () => {
    const token = input[i++];
    if (token !== "0" && token !== "1") rejectImport("SVG_ARC_FLAG", location);
    return token === "1";
  };
  const finish = () => {
    if (part.length > 0) output.push({ commands: part });
    part = [];
  };
  while (i < input.length) {
    if (COMMANDS.test(input[i]!)) command = input[i++]!;
    if (command === "") rejectImport("SVG_PATH_COMMAND_REQUIRED", location);
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const coordinate = (): PathPoint => ({ x: read() + (relative ? point.x : 0), y: read() + (relative ? point.y : 0) });
    if (upper !== "M" && part.length === 0) {
      if (previous !== "Z" || upper === "Z") rejectImport("SVG_PATH_MOVETO_REQUIRED", location);
      start = point;
      part.push({ op: "m", point });
    }
    switch (upper) {
      case "M": finish(); point = start = coordinate(); part.push({ op: "m", point }); command = relative ? "l" : "L"; break;
      case "L": point = coordinate(); part.push({ op: "l", point }); break;
      case "H": point = { x: read() + (relative ? point.x : 0), y: point.y }; part.push({ op: "l", point }); break;
      case "V": point = { x: point.x, y: read() + (relative ? point.y : 0) }; part.push({ op: "l", point }); break;
      case "Z": part.push({ op: "h" }); point = start; command = ""; finish(); break;
      case "C": {
        const control1 = coordinate(), control2 = coordinate(), to = coordinate();
        part.push({ op: "c", control1, control2, to }); point = to; control = control2; break;
      }
      case "S": {
        const control1 = previous === "C" || previous === "S" ? reflected(point, control) : point;
        const control2 = coordinate(), to = coordinate();
        part.push({ op: "c", control1, control2, to }); point = to; control = control2; break;
      }
      case "Q":
      case "T": {
        const quadratic = upper === "Q" ? coordinate() : previous === "Q" || previous === "T" ? reflected(point, control) : point;
        const to = coordinate();
        part.push({ op: "c", control1: blend(point, quadratic, 2 / 3), control2: blend(to, quadratic, 2 / 3), to });
        point = to; control = quadratic; break;
      }
      case "A": {
        const rx = read(), ry = read(), angle = read(), large = flag(), sweep = flag(), to = coordinate();
        if (rx < 0 || ry < 0) rejectImport("SVG_ARC_RADIUS", location);
        const arc = ellipseArc(point, to, rx, ry, angle, large, sweep);
        if (arc !== undefined) part.push(arc);
        point = to; break;
      }
    }
    previous = upper;
  }
  finish();
  if (output.length === 0) rejectImport("SVG_EMPTY_PATH", location);
  return output;
}
