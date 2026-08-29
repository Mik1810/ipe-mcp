import { createHash } from "node:crypto";
import { basename } from "node:path";

import { buildCameraPan, buildMotion, buildPanelScroll, buildReveal, setTransition } from "../animation/index.js";
import { composeSlide, addLayer, addView, createPage, deleteLayer, deletePage, deleteView, reorderLayers, reorderPages, reorderViews, updateLayer, updatePage, updateView } from "../composition/index.js";
import { ipeDocumentCodec, type IpeDocument } from "../core/ipe-document-codec.js";
import { validateDocument } from "../domain/validate.js";
import { applyLayoutPlan, createLayoutPlan } from "../layout/plan.js";
import { layoutGrid, layoutLinear, layoutStack, transformForPlacement, type Placement } from "../layout/layout.js";
import { composeTransform } from "../layout/matrix.js";
import { NativeIpeAdapter, type NativeAdapterOptions } from "../native/adapter.js";
import { addBitmapAsset, applyObjectOperations, buildFittedImageObject, buildPathObject, buildStylesheet, buildSymbolObject, buildTextObject, compilePath, type PathSpec, type StyleDefinition } from "../objects/index.js";
import { DocumentSessionManager } from "../persistence/session-manager.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import type { PublicOperation, PublicViewBuild } from "./contracts.js";
import { sanitizePublicText } from "./errors.js";
import { MCP_LIMITS, checkDocumentShapeLimits } from "../limits.js";

const SOURCE_RESOURCE_LIMIT = MCP_LIMITS.sourceResourceBytes;

function minimalSource(preset: "standard" | "16:9", title?: string): string {
  const layout = preset === "16:9" ? '<ipestyle name="ipe-mcp-layout"><layout paper="1280 720" origin="32 0" frame="1216 648"/></ipestyle>' : "";
  const metadata = title === undefined ? "" : `<info title="${title.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"/>`;
  return `<ipe version="70218">${metadata}${layout}<page><layer name="content"/><view layers="content" active="content" marked="no"/></page></ipe>`;
}

function ids(document: IpeDocument): Set<string> {
  return new Set([
    ...(document.stylesheets ?? document.styles ?? []).map((style) => style.id),
    ...(document.assets ?? []).map((asset) => asset.id),
    ...document.pages.flatMap((page) => [page.id, ...page.layers.map((layer) => layer.id), ...page.views.map((view) => view.id), ...page.objects.map((object) => object.id)]),
  ]);
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("bitmap dataBase64 is not canonical base64");
  return Buffer.from(value, "base64");
}

function stylesheetId(name: string, definitions: readonly unknown[], used: ReadonlySet<string>): string {
  let salt = 0;
  let id = "";
  do id = `style-${createHash("sha256").update(`ipe-mcp/m8/style/${name}/${JSON.stringify(definitions)}/${salt++}`).digest("hex").slice(0, 24)}`; while (used.has(id));
  return id;
}

function layoutPlacements(layout: Extract<PublicOperation, { op: "layout_objects" }>["layout"]): readonly Placement[] {
  const items = layout.items.map((item) => ({ id: item.objectId, size: { width: item.source.width, height: item.source.height } }));
  if (layout.primitive === "row" || layout.primitive === "column") return layoutLinear({
    container: layout.container, items, direction: layout.primitive,
    ...(layout.gap === undefined ? {} : { gap: layout.gap }), ...(layout.padding === undefined ? {} : { padding: layout.padding }),
    ...(layout.mainAlign === undefined ? {} : { mainAlign: layout.mainAlign }), ...(layout.crossAlign === undefined ? {} : { crossAlign: layout.crossAlign }),
  });
  if (layout.primitive === "grid") return layoutGrid({ container: layout.container, items, columns: layout.columns, ...(layout.rowGap === undefined ? {} : { rowGap: layout.rowGap }), ...(layout.columnGap === undefined ? {} : { columnGap: layout.columnGap }) });
  if (!("horizontalAlign" in layout)) throw new Error("unsupported layout primitive");
  const anchor = `${layout.verticalAlign ?? "center"}-${layout.horizontalAlign ?? "center"}`;
  const mapped = anchor === "top-left" || anchor === "top-right" || anchor === "bottom-left" || anchor === "bottom-right" ? anchor : "center";
  return layoutStack({ container: layout.container, items, anchor: mapped });
}

function opaqueSnapshotId(documentId: string, path: string): string {
  const hex = createHash("sha256").update(`${documentId}:${basename(path)}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function previousValues(document: IpeDocument, operations: readonly PublicOperation[]): readonly Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const operation of operations) {
    if (operation.op === "set_metadata") values.push({ op: operation.op, value: document.metadata ?? {} });
    if (operation.op === "update_page") {
      const page = document.pages.find((item) => item.id === operation.pageId);
      if (page !== undefined) values.push({ op: operation.op, id: page.id, value: { name: page.name ?? null, title: page.title ?? null, notes: page.notes ?? null, marked: page.marked ?? null } });
    }
    if (operation.op === "update_layer") {
      const layer = document.pages.find((item) => item.id === operation.pageId)?.layers.find((item) => item.id === operation.layerId);
      if (layer !== undefined) values.push({ op: operation.op, id: layer.id, value: { name: layer.name, edit: layer.edit ?? null, snap: layer.snap ?? null } });
    }
    if (operation.op === "update_view") {
      const view = document.pages.find((item) => item.id === operation.pageId)?.views.find((item) => item.id === operation.viewId);
      if (view !== undefined) values.push({ op: operation.op, id: view.id, value: { visibleLayerIds: view.visibleLayerIds, activeLayerId: view.activeLayerId, marked: view.marked } });
    }
  }
  return values;
}

function outline(document: IpeDocument, maxObjects: number = MCP_LIMITS.inspectObjectsDefault): Record<string, unknown> {
  let remaining = maxObjects;
  const pages = document.pages.map((page) => {
    const shown = page.objects.slice(0, Math.max(0, remaining)); remaining -= shown.length;
    return {
      id: page.id, ...(page.name === undefined ? {} : { name: page.name }), ...(page.title === undefined ? {} : { title: page.title }),
      layers: page.layers.map(({ id, name, edit, snap }) => ({ id, name, ...(edit === undefined ? {} : { edit }), ...(snap === undefined ? {} : { snap }) })),
      views: page.views.map(({ id, name, visibleLayerIds, activeLayerId, marked }) => ({ id, ...(name === undefined ? {} : { name }), visibleLayerIds, activeLayerId, marked })),
      objects: shown.map(({ id, layerId, zOrder, xml }) => ({ id, layerId, zOrder, type: xml?.name ?? "unknown" })), objectCount: page.objects.length,
    };
  });
  const objectCount = document.pages.reduce((sum, page) => sum + page.objects.length, 0);
  return { schemaVersion: document.schemaVersion, format: document.format, pageCount: document.pages.length, objectCount, pages, truncated: objectCount > maxObjects, returnedObjectCount: Math.min(objectCount, maxObjects) };
}

export class IpeMcpService {
  readonly artifacts = new ArtifactStore();
  readonly #diagnostics = new Map<string, readonly Record<string, unknown>[]>();

  private constructor(readonly sessions: DocumentSessionManager<IpeDocument>, readonly native: NativeIpeAdapter) {}

  static async create(workspaceRoots: readonly string[], stateRoot: string, nativeOptions: NativeAdapterOptions = {}): Promise<IpeMcpService> {
    const sessions = await DocumentSessionManager.create<IpeDocument>({ workspaceRoots, stateRoot, mutationGuard: (document: unknown) => checkDocumentShapeLimits(document as IpeDocument) }, ipeDocumentCodec);
    const native = await NativeIpeAdapter.create(nativeOptions);
    return new IpeMcpService(sessions, native);
  }

  async createDocument(preset: "standard" | "16:9", title?: string) {
    const opened = await this.sessions.create(ipeDocumentCodec.parse(minimalSource(preset, title)));
    return { documentId: opened.documentId, revision: opened.revision, outline: outline(opened.document) };
  }

  async openDocument(path: string) {
    const opened = await this.sessions.open(path);
    return { documentId: opened.documentId, revision: opened.revision, outline: outline(opened.document) };
  }

  inspect(documentId: string, maxObjects: number = MCP_LIMITS.inspectObjectsDefault) {
    const current = this.sessions.inspect(documentId);
    return { documentId, revision: current.revision, outline: outline(current.document, maxObjects) };
  }

  async apply(documentId: string, expectedRevision: number, operations: readonly PublicOperation[], confirmation?: string) {
    const destructive = operations.some((operation) => operation.op.startsWith("delete_"));
    if (destructive && confirmation !== "DELETE") throw new Error("delete operations require confirmation='DELETE'");
    const beforeDocument = this.sessions.inspect(documentId).document;
    const before = ids(beforeDocument);
    const previous = previousValues(beforeDocument, operations);
    const result = await this.sessions.mutate(documentId, expectedRevision, (draft) => {
      for (const operation of operations) {
        switch (operation.op) {
          case "set_metadata": draft.metadata = { ...(draft.metadata ?? {}), ...(operation.title === undefined ? {} : { title: operation.title }), ...(operation.author === undefined ? {} : { author: operation.author }) }; break;
          case "add_page": createPage(draft, { ...(operation.name === undefined ? {} : { name: operation.name }), ...(operation.title === undefined ? {} : { title: operation.title }) }); break;
          case "update_page": updatePage(draft, operation.pageId, Object.fromEntries(Object.entries(operation.patch).filter(([, value]) => value !== undefined))); break;
          case "delete_page": deletePage(draft, operation.pageId); break;
          case "reorder_pages": reorderPages(draft, operation.pageIds); break;
          case "add_layer": addLayer(draft, operation.pageId, { name: operation.name, ...(operation.intentional === undefined ? {} : { intentional: operation.intentional }) }); break;
          case "update_layer": updateLayer(draft, operation.pageId, operation.layerId, { ...(operation.name === undefined ? {} : { name: operation.name }), ...(operation.edit === undefined ? {} : { edit: operation.edit }), ...(operation.snap === undefined ? {} : { snap: operation.snap }) }); break;
          case "delete_layer": deleteLayer(draft, operation.pageId, operation.layerId); break;
          case "reorder_layers": reorderLayers(draft, operation.pageId, operation.layerIds); break;
          case "add_view": addView(draft, operation.pageId, { ...(operation.name === undefined ? {} : { name: operation.name }), visibleLayerIds: operation.visibleLayerIds, activeLayerId: operation.activeLayerId, ...(operation.marked === undefined ? {} : { marked: operation.marked }) }); break;
          case "update_view": updateView(draft, operation.pageId, operation.viewId, { ...(operation.visibleLayerIds === undefined ? {} : { visibleLayerIds: operation.visibleLayerIds }), ...(operation.activeLayerId === undefined ? {} : { activeLayerId: operation.activeLayerId }), ...(operation.marked === undefined ? {} : { marked: operation.marked }) }); break;
          case "delete_view": deleteView(draft, operation.pageId, operation.viewId); break;
          case "reorder_views": reorderViews(draft, operation.pageId, operation.viewIds); break;
          case "add_rectangle": applyObjectOperations(draft, operation.pageId, [{ op: "insert", object: buildPathObject({ layerId: operation.layerId, path: { kind: "rectangle", x: operation.x, y: operation.y, width: operation.width, height: operation.height, style: { ...(operation.stroke === undefined ? {} : { stroke: operation.stroke }), ...(operation.fill === undefined ? {} : { fill: operation.fill }) } } }), ...(operation.position === undefined ? {} : { position: operation.position }) }]); break;
          case "add_segment": applyObjectOperations(draft, operation.pageId, [{ op: "insert", object: buildPathObject({ layerId: operation.layerId, path: { kind: "segment", from: operation.from, to: operation.to, style: operation.stroke === undefined ? {} : { stroke: operation.stroke } } }), ...(operation.position === undefined ? {} : { position: operation.position }) }]); break;
          case "add_path": applyObjectOperations(draft, operation.pageId, [{ op: "insert", object: buildPathObject({ layerId: operation.layerId, path: operation.path as PathSpec }), ...(operation.position === undefined ? {} : { position: operation.position }) }]); break;
          case "add_text": applyObjectOperations(draft, operation.pageId, [{ op: "insert", object: buildTextObject({ layerId: operation.layerId, text: operation.text, position: operation.position, ...(operation.width === undefined ? {} : { type: "minipage", width: operation.width }), ...(operation.stroke === undefined ? {} : { stroke: operation.stroke }), ...(operation.size === undefined ? {} : { size: operation.size }) }), ...(operation.positionInZOrder === undefined ? {} : { position: operation.positionInZOrder }) }]); break;
          case "add_image": {
            const asset = addBitmapAsset(draft, decodeBase64(operation.dataBase64), operation.mediaType, { maxInputBytes: MCP_LIMITS.imageDecodedBytes }).asset;
            const object = buildFittedImageObject({ layerId: operation.layerId, asset, target: operation.target, ...(operation.fit === undefined ? {} : { fit: operation.fit }), ...(operation.opacity === undefined ? {} : { opacity: operation.opacity }) });
            applyObjectOperations(draft, operation.pageId, [{ op: "insert", object, ...(operation.position === undefined ? {} : { position: operation.position }) }]);
            break;
          }
          case "add_symbol_use": applyObjectOperations(draft, operation.pageId, [{ op: "insert", object: buildSymbolObject({ layerId: operation.layerId, name: operation.name, ...(operation.position === undefined ? {} : { position: operation.position }), ...(operation.stroke === undefined ? {} : { stroke: operation.stroke }), ...(operation.fill === undefined ? {} : { fill: operation.fill }), ...(operation.size === undefined ? {} : { size: operation.size }) }), ...(operation.positionInZOrder === undefined ? {} : { position: operation.positionInZOrder }) }]); break;
          case "replace_object": {
            const existing = draft.pages.find((page) => page.id === operation.pageId)?.objects.find((object) => object.id === operation.objectId);
            if (existing === undefined) throw new Error(`object '${operation.objectId}' does not exist on page '${operation.pageId}'`);
            const replacement = operation.replacement.kind === "path"
              ? buildPathObject({ layerId: existing.layerId, path: operation.replacement.path as PathSpec })
              : operation.replacement.kind === "text"
                ? buildTextObject({ layerId: existing.layerId, text: operation.replacement.text, position: operation.replacement.position, ...(operation.replacement.width === undefined ? {} : { type: "minipage", width: operation.replacement.width }), ...(operation.replacement.stroke === undefined ? {} : { stroke: operation.replacement.stroke }), ...(operation.replacement.size === undefined ? {} : { size: operation.replacement.size }) })
                : buildSymbolObject({ layerId: existing.layerId, name: operation.replacement.name, ...(operation.replacement.position === undefined ? {} : { position: operation.replacement.position }), ...(operation.replacement.stroke === undefined ? {} : { stroke: operation.replacement.stroke }), ...(operation.replacement.fill === undefined ? {} : { fill: operation.replacement.fill }), ...(operation.replacement.size === undefined ? {} : { size: operation.replacement.size }) });
            applyObjectOperations(draft, operation.pageId, [{ op: "replace", objectId: operation.objectId, replacement }]);
            break;
          }
          case "duplicate_object": applyObjectOperations(draft, operation.pageId, [{ op: "duplicate", objectId: operation.objectId, ...(operation.position === undefined ? {} : { position: operation.position }) }]); break;
          case "delete_object": applyObjectOperations(draft, operation.pageId, [{ op: "delete", objectId: operation.objectId }]); break;
          case "move_object": applyObjectOperations(draft, operation.pageId, [{ op: "move", objectId: operation.objectId, position: operation.position }]); break;
          case "set_object_layer": applyObjectOperations(draft, operation.pageId, [{ op: "layer", objectId: operation.objectId, layerId: operation.layerId }]); break;
          case "transform_object": applyLayoutPlan(draft, createLayoutPlan(operation.pageId, [{ objectId: operation.objectId, matrix: operation.matrix, space: operation.space }])); break;
          case "group_objects": applyObjectOperations(draft, operation.pageId, [{ op: "group", objectIds: operation.objectIds, ...(operation.clip === undefined ? {} : { clip: operation.clip as PathSpec }), ...(operation.url === undefined ? {} : { url: operation.url }), ...(operation.decoration === undefined ? {} : { decoration: operation.decoration }) }]); break;
          case "ungroup_object": applyObjectOperations(draft, operation.pageId, [{ op: "ungroup", objectId: operation.objectId }]); break;
          case "add_stylesheet": {
            const used = ids(draft);
            const definitions = operation.definitions.map((definition): StyleDefinition => definition.kind === "symbol" ? { kind: "symbol", name: definition.name, object: compilePath(definition.path as PathSpec) } : definition as StyleDefinition);
            const sheet = buildStylesheet(stylesheetId(operation.name, operation.definitions, used), operation.name, definitions);
            if (draft.stylesheets !== undefined || draft.styles === undefined) draft.stylesheets = [...(draft.stylesheets ?? []), sheet]; else draft.styles = [...draft.styles, sheet];
            break;
          }
          case "layout_objects": {
            const placements = layoutPlacements(operation.layout);
            const byId = new Map(operation.layout.items.map((item) => [item.objectId, item.source]));
            applyLayoutPlan(draft, createLayoutPlan(operation.pageId, placements.map((placement) => ({ objectId: placement.id, matrix: composeTransform(transformForPlacement(byId.get(placement.id)!, placement.box)), space: "page" }))));
            break;
          }
        }
      }
    });
    const after = ids(result.document);
    return { documentId, revision: result.revision, createdIds: [...after].filter((id) => !before.has(id)), deletedIds: [...before].filter((id) => !after.has(id)), previousValues: previous, outline: outline(result.document) };
  }

  async compose(documentId: string, expectedRevision: number, input: { preset: "standard" | "16:9"; name?: string | undefined; title?: string | undefined; notes?: string | undefined; layers?: readonly string[] | undefined }) {
    let pageId = "";
    const result = await this.sessions.mutate(documentId, expectedRevision, (draft) => {
      const page = composeSlide(draft, { preset: input.preset, ...(input.name === undefined ? {} : { name: input.name }), ...(input.title === undefined ? {} : { title: input.title }), ...(input.notes === undefined ? {} : { notes: input.notes }), ...(input.layers === undefined ? {} : { layers: input.layers.map((name) => ({ name })) }) });
      pageId = page.id;
    });
    const page = result.document.pages.find((candidate) => candidate.id === pageId)!;
    return { documentId, revision: result.revision, pageId, layerIds: page.layers.map((layer) => layer.id), viewIds: page.views.map((view) => view.id) };
  }

  async buildViews(documentId: string, expectedRevision: number, input: PublicViewBuild) {
    let built: ReturnType<typeof buildReveal> | undefined;
    const result = await this.sessions.mutate(documentId, expectedRevision, (draft) => {
      if (input.kind === "reveal") built = buildReveal(draft, input.pageId, { groups: input.groups, ...(input.cumulative === undefined ? {} : { cumulative: input.cumulative }), ...(input.name === undefined ? {} : { name: input.name }) });
      else if (input.kind === "motion") built = buildMotion(draft, input.pageId, { objectIds: input.objectIds, from: input.from, to: input.to, steps: input.steps, ...(input.easing === undefined ? {} : { easing: input.easing }), ...(input.name === undefined ? {} : { name: input.name }), strategy: "duplicate", staticFallback: true, bbox: { kind: "fixed" } });
      else if (input.kind === "panel_scroll") built = buildPanelScroll(draft, input.pageId, { objectId: input.objectId, axis: input.axis, from: input.from, to: input.to, clip: input.clip, steps: input.steps, ...(input.easing === undefined ? {} : { easing: input.easing }), ...(input.name === undefined ? {} : { name: input.name }), staticFallback: true });
      else if (input.kind === "camera_pan") built = buildCameraPan(draft, input.pageId, { ...(input.objectIds === undefined ? {} : { objectIds: input.objectIds }), ...(input.includeReservedLayers === undefined ? {} : { includeReservedLayers: input.includeReservedLayers }), from: input.from, to: input.to, steps: input.steps, ...(input.easing === undefined ? {} : { easing: input.easing }), ...(input.name === undefined ? {} : { name: input.name }), strategy: "duplicate", staticFallback: true });
      else { const diagnostics = setTransition(draft, input.pageId, input.viewIds, { effect: input.effect, ...(input.duration === undefined ? {} : { duration: input.duration }), ...(input.transition === undefined ? {} : { transition: input.transition }), ...(input.viewer === undefined ? {} : { viewer: input.viewer }) }); built = { viewIds: input.viewIds, layerIds: [], objectIds: [], estimate: { generatedViews: 0, generatedCopies: 0, resultingPdfPages: draft.pages.reduce((sum, page) => sum + page.views.length, 0) }, diagnostics }; }
    });
    return { documentId, revision: result.revision, ...built! };
  }

  async validate(documentId: string, level: "structural" | "full") {
    const current = this.sessions.inspect(documentId);
    if (level === "structural") {
      const report = validateDocument(current.document);
      this.#diagnostics.set(documentId, report.diagnostics.map((item) => ({ severity: item.severity, code: item.code, path: item.path, message: sanitizePublicText(item.message).slice(0, MCP_LIMITS.diagnosticChars) })));
      return { documentId, revision: current.revision, level, ok: report.ok, diagnosticCount: report.diagnostics.length };
    }
    const report = await this.native.validateFull(current.document);
    this.#diagnostics.set(documentId, report.diagnostics.map((item) => ({ level: item.level, code: item.code, message: sanitizePublicText(item.message).slice(0, MCP_LIMITS.diagnosticChars) })));
    return { documentId, revision: current.revision, level, ok: report.ok, capabilityMode: report.capabilities.mode, diagnosticCount: report.diagnostics.length };
  }

  async capabilities() { return await this.native.capabilities(); }

  async render(documentId: string, pageId?: string, viewId?: string) {
    const current = this.sessions.inspect(documentId);
    const rendered = await this.native.renderViews(current.document, "png");
    const selected = rendered.filter((item) => (pageId === undefined || item.metadata.pageId === pageId) && (viewId === undefined || item.metadata.viewId === viewId));
    if (selected.length === 0) throw new Error("requested page/view does not exist");
    return selected.map((item) => this.artifacts.put({ family: "preview", data: Buffer.from(item.data), mediaType: item.metadata.mediaType, name: `page-${item.metadata.page}-view-${item.metadata.view}.png`, sha256: item.metadata.sha256, metadata: item.metadata as unknown as Record<string, unknown> }));
  }

  async export(documentId: string, format: "pdf" | "png") {
    const current = this.sessions.inspect(documentId);
    if (format === "pdf") {
      const item = await this.native.exportPdf(current.document);
      return [this.artifacts.put({ family: "artifact", data: Buffer.from(item.data), mediaType: item.metadata.mediaType, name: "document.pdf", sha256: item.metadata.sha256, metadata: item.metadata as unknown as Record<string, unknown> })];
    }
    const items = await this.native.renderViews(current.document, "png");
    return items.map((item) => this.artifacts.put({ family: "artifact", data: Buffer.from(item.data), mediaType: item.metadata.mediaType, name: `page-${item.metadata.page}-view-${item.metadata.view}.png`, sha256: item.metadata.sha256, metadata: item.metadata as unknown as Record<string, unknown> }));
  }

  async save(documentId: string, expectedRevision: number, targetPath: string) {
    const saved = await this.sessions.save(documentId, expectedRevision, targetPath);
    return { documentId, revision: saved.revision, sourceHash: saved.sourceHash, snapshotCreated: saved.snapshotPath !== undefined };
  }

  async history(documentId: string, action: "list" | "snapshot" | "undo" | "restore", expectedRevision?: number, snapshotId?: string) {
    if (action === "list") return { documentId, revision: this.sessions.inspect(documentId).revision, snapshots: (await this.sessions.snapshots(documentId)).map((path) => ({ snapshotId: opaqueSnapshotId(documentId, path) })) };
    if (expectedRevision === undefined) throw new Error(`${action} requires expectedRevision`);
    if (action === "snapshot") { const path = await this.sessions.createSnapshot(documentId, expectedRevision); return { documentId, revision: expectedRevision, snapshotId: opaqueSnapshotId(documentId, path) }; }
    const snapshots = action === "restore" ? await this.sessions.snapshots(documentId) : [];
    const selected = snapshotId === undefined ? undefined : snapshots.find((path) => opaqueSnapshotId(documentId, path) === snapshotId);
    if (action === "restore" && selected === undefined) throw new Error("unknown snapshotId; call ipe_history with action='list'");
    const result = action === "undo" ? await this.sessions.undo(documentId, expectedRevision) : await this.sessions.restoreSnapshot(documentId, expectedRevision, selected);
    return { documentId, revision: result.revision, action };
  }

  async recover() { return (await this.sessions.recover()).map((item) => ({ documentId: item.documentId, revision: item.revision })); }

  documentResource(documentId: string, kind: "summary" | "source" | "diagnostics") {
    const current = this.sessions.inspect(documentId);
    if (kind === "summary") return { mimeType: "application/json", text: JSON.stringify({ documentId, revision: current.revision, outline: outline(current.document) }) };
    if (kind === "diagnostics") return { mimeType: "application/json", text: JSON.stringify({ documentId, revision: current.revision, diagnostics: this.#diagnostics.get(documentId) ?? [] }) };
    const source = ipeDocumentCodec.serialize(current.document); const bytes = Buffer.byteLength(source); const bounded = Buffer.from(source).subarray(0, SOURCE_RESOURCE_LIMIT).toString("utf8");
    return { mimeType: "application/xml", text: bounded, metadata: { truncated: bytes > SOURCE_RESOURCE_LIMIT, bytes, returnedBytes: Buffer.byteLength(bounded), sha256: createHash("sha256").update(source).digest("hex") } };
  }

  artifactResource(family: "artifact" | "preview", id: string): StoredArtifact {
    const item = this.artifacts.get(id); if (item === undefined || item.family !== family) throw new Error("resource not found"); return item;
  }
}
