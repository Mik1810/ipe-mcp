import { anchorPoint, assertBox, assertFiniteNumber, type Anchor, type BoundsResult, type Box, type Point } from "./geometry.js";

export type ConnectorKind = "straight" | "orthogonal";
export type ConnectorTieBreak = "horizontal-first" | "vertical-first";
export type ConnectorBoxAnchor = Exclude<Anchor, "baseline-left">;

export interface ConnectorEndpoint {
  readonly objectId: string;
  readonly anchor: Anchor | "auto";
  readonly boxKind: "logical" | "geometric" | "visual";
  readonly offset?: Point;
}

export interface ConnectorIntentV1 {
  readonly id: string;
  readonly from: ConnectorEndpoint;
  readonly to: ConnectorEndpoint;
  readonly routing: ConnectorKind;
  readonly tieBreak?: ConnectorTieBreak;
}

export interface ConnectorRoute {
  readonly kind: ConnectorKind;
  readonly fromAnchor: Anchor;
  readonly toAnchor: Anchor;
  readonly points: readonly Point[];
}

function automaticAnchors(from: Box, to: Box): readonly [ConnectorBoxAnchor, ConnectorBoxAnchor] {
  const fromCenter = anchorPoint(from, "center");
  const toCenter = anchorPoint(to, "center");
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (dx === 0 && dy === 0) throw new Error("cannot route between overlapping box centers");
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["top", "bottom"] : ["bottom", "top"];
}

function deduplicateAdjacent(points: readonly Point[]): Point[] {
  return points.filter((point, index) => index === 0
    || point.x !== points[index - 1]!.x
    || point.y !== points[index - 1]!.y);
}

function offsetPoint(point: Point, offset?: Point): Point {
  if (!offset) return point;
  assertFiniteNumber(offset.x, "connector offset.x");
  assertFiniteNumber(offset.y, "connector offset.y");
  const result = { x: point.x + offset.x, y: point.y + offset.y };
  assertFiniteNumber(result.x, "connector point.x");
  assertFiniteNumber(result.y, "connector point.y");
  return result;
}

function routePoints(
  start: Point,
  end: Point,
  kind: ConnectorKind,
  fromAnchor: Anchor,
  toAnchor: Anchor,
  tieBreak: ConnectorTieBreak,
): ConnectorRoute {
  if (start.x === end.x && start.y === end.y) throw new Error("connector segment must not have zero length");
  if (kind === "straight") return { kind, fromAnchor, toAnchor, points: [start, end] };
  const horizontalFirst = tieBreak === "horizontal-first";
  const bend = horizontalFirst ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
  return { kind, fromAnchor, toAnchor, points: deduplicateAdjacent([start, bend, end]) };
}

export function routeConnector(
  from: Box,
  to: Box,
  kind: ConnectorKind = "straight",
  anchors?: readonly [ConnectorBoxAnchor, ConnectorBoxAnchor],
  tieBreak: ConnectorTieBreak = "horizontal-first",
): ConnectorRoute {
  assertBox(from, "connector from box");
  assertBox(to, "connector to box");
  const [fromAnchor, toAnchor] = anchors ?? automaticAnchors(from, to);
  const start = anchorPoint(from, fromAnchor);
  const end = anchorPoint(to, toAnchor);
  return routePoints(start, end, kind, fromAnchor, toAnchor, tieBreak);
}

function connectorBox(result: BoundsResult, endpoint: ConnectorEndpoint): Box {
  if (result.status === "deferred") {
    throw new Error(`connector object '${endpoint.objectId}' bounds are deferred: ${result.reason}`);
  }
  return result.boxes[endpoint.boxKind];
}

function endpointPoint(result: BoundsResult, endpoint: ConnectorEndpoint, anchor: Anchor): Point {
  const box = connectorBox(result, endpoint);
  if (anchor !== "baseline-left") return anchorPoint(box, anchor);
  if (endpoint.boxKind !== "logical") throw new Error("baseline-left connector anchors require logical bounds");
  if (result.status === "deferred" || result.baselineFromBottom === undefined) {
    throw new Error(`connector object '${endpoint.objectId}' requires a known baseline`);
  }
  return anchorPoint(box, anchor, result.baselineFromBottom);
}

/** Resolve persistent endpoint IDs, box kinds, independent auto anchors and offsets. */
export function resolveConnectorIntent(
  intent: ConnectorIntentV1,
  bounds: ReadonlyMap<string, BoundsResult>,
): ConnectorRoute {
  if (intent.from.objectId === intent.to.objectId) throw new Error("connector endpoints must reference distinct objects");
  const fromResult = bounds.get(intent.from.objectId);
  const toResult = bounds.get(intent.to.objectId);
  if (!fromResult) throw new Error(`connector object '${intent.from.objectId}' is missing`);
  if (!toResult) throw new Error(`connector object '${intent.to.objectId}' is missing`);
  const fromBox = connectorBox(fromResult, intent.from);
  const toBox = connectorBox(toResult, intent.to);
  const automatic = intent.from.anchor === "auto" || intent.to.anchor === "auto"
    ? automaticAnchors(fromBox, toBox)
    : undefined;
  const fromAnchor = intent.from.anchor === "auto" ? automatic![0] : intent.from.anchor;
  const toAnchor = intent.to.anchor === "auto" ? automatic![1] : intent.to.anchor;
  const start = offsetPoint(endpointPoint(fromResult, intent.from, fromAnchor), intent.from.offset);
  const end = offsetPoint(endpointPoint(toResult, intent.to, toAnchor), intent.to.offset);
  return routePoints(start, end, intent.routing, fromAnchor, toAnchor, intent.tieBreak ?? "horizontal-first");
}
