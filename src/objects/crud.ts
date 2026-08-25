import { stylesheetList, type DocumentIR, type IpeObject, type Matrix, type Page } from "../domain/ir.js";
import { assertPersistentEntityId, objectIdFromCustom } from "../domain/identity.js";
import { matrixSchema } from "../domain/schema.js";
import type { XmlElement } from "../domain/xml-node.js";
import { IDENTITY_MATRIX, multiplyMatrices } from "../layout/matrix.js";
import { buildGroupObject } from "./builders.js";
import { cloneObject, createObjectIdentity, objectKind, type ObjectIdentity } from "./common.js";
import type { PathSpec } from "./path.js";
import { nestedReferences } from "./references.js";
import { assertObjectContent } from "./content-model.js";
import { validateDocument } from "../domain/validate.js";

export type ObjectPosition =
  | { readonly kind: "back" | "front" }
  | { readonly kind: "before" | "after"; readonly objectId: string }
  | { readonly kind: "index"; readonly index: number };

export type ObjectOperation =
  | { readonly op: "insert"; readonly object: IpeObject; readonly position?: ObjectPosition }
  | { readonly op: "replace"; readonly objectId: string; readonly replacement: IpeObject; readonly preserveIdentity?: boolean }
  | { readonly op: "duplicate"; readonly objectId: string; readonly identity?: ObjectIdentity; readonly position?: ObjectPosition }
  | { readonly op: "delete"; readonly objectId: string }
  | { readonly op: "move"; readonly objectId: string; readonly position: ObjectPosition }
  | { readonly op: "layer"; readonly objectId: string; readonly layerId: string }
  | { readonly op: "group"; readonly objectIds: readonly string[]; readonly identity?: ObjectIdentity; readonly clip?: PathSpec; readonly url?: string; readonly decoration?: string }
  | { readonly op: "ungroup"; readonly objectId: string };

export interface ObjectMutationResult {
  readonly pageId: string;
  readonly affectedObjectIds: readonly string[];
  readonly objectIdsBackToFront: readonly string[];
}

function pageById(document: DocumentIR, pageId: string): Page {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`page '${pageId}' does not exist`);
  return page;
}

function indexOf(objects: readonly IpeObject[], objectId: string): number {
  const index = objects.findIndex((object) => object.id === objectId);
  if (index < 0) throw new Error(`object '${objectId}' does not exist`);
  return index;
}

function insertionIndex(objects: readonly IpeObject[], position: ObjectPosition = { kind: "front" }): number {
  if (position.kind === "back") return 0;
  if (position.kind === "front") return objects.length;
  if (position.kind === "index") {
    if (!Number.isSafeInteger(position.index) || position.index < 0 || position.index > objects.length) {
      throw new Error("object insertion index is out of range");
    }
    return position.index;
  }
  if (position.kind === "before" || position.kind === "after") {
    const reference = indexOf(objects, position.objectId);
    return position.kind === "before" ? reference : reference + 1;
  }
  throw new Error("unsupported object position");
}

function normalizeZOrder(objects: IpeObject[]): void {
  objects.forEach((object, index) => { object.zOrder = index; });
}

function assertLayer(page: Page, layerId: string): void {
  if (!page.layers.some((layer) => layer.id === layerId)) throw new Error(`layer '${layerId}' does not exist on page '${page.id}'`);
}

function referencesTo(document: DocumentIR, workingPageId: string, working: readonly IpeObject[], targetIds: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const page of document.pages) {
    const objects = page.id === workingPageId ? working : page.objects;
    for (const object of objects) {
      for (const reference of object.references ?? []) {
        if (reference.kind === "object" && targetIds.has(reference.id)) hits.push(`${page.id}/${object.id}`);
      }
    }
  }
  return hits;
}

function parseOptionalMatrix(value: string | undefined): Matrix | undefined {
  if (value === undefined) return undefined;
  const numbers = value.trim().split(/\s+/u).map(Number);
  return matrixSchema.parse(numbers) as Matrix;
}

function symbolNames(document: DocumentIR): Set<string> {
  const names = new Set<string>(["arrow/normal(spx)"]);
  for (const sheet of stylesheetList(document)) {
    for (const child of sheet.xml?.children ?? []) {
      if (child.type === "element" && child.name === "symbol" && child.attributes?.name) names.add(child.attributes.name);
    }
  }
  return names;
}

/** Validate references introduced by a new or replacement object. */
function assertObjectReferences(document: DocumentIR, page: Page, object: IpeObject, pageObjects: readonly IpeObject[] = page.objects): void {
  const assets = new Set((document.assets ?? []).map((asset) => asset.id));
  const styles = new Set(stylesheetList(document).map((style) => style.id));
  const symbols = symbolNames(document);
  const objects = new Set(pageObjects.map((candidate) => candidate.id));
  const embedded = object.xml === undefined ? [] : nestedReferences(document, object.xml);
  const references = [...(object.references ?? []), ...embedded].filter((reference, index, all) => all.findIndex((candidate) => candidate.kind === reference.kind && candidate.id === reference.id) === index);
  if (references.length > 0) object.references = references;
  for (const reference of references) {
    const target = reference.kind === "asset" ? assets : reference.kind === "style" ? styles : reference.kind === "symbol" ? symbols : reference.kind === "object" ? objects : undefined;
    if (target && !target.has(reference.id)) throw new Error(`${reference.kind} reference '${reference.id}' does not resolve`);
  }
  if (object.assetId !== undefined && !assets.has(object.assetId)) throw new Error(`asset reference '${object.assetId}' does not resolve`);
  if (object.styleId !== undefined && !styles.has(object.styleId)) throw new Error(`style reference '${object.styleId}' does not resolve`);
  if (object.symbolId !== undefined && !symbols.has(object.symbolId)) throw new Error(`symbol reference '${object.symbolId}' does not resolve`);
}

function remapNestedObjectIdentities(xml: XmlElement, requestedIdentity?: ObjectIdentity): void {
  const attributes = (xml.attributes ??= {});
  // Keep duplicated groups and their XML payload coherent. Native Ipe may
  // remove x-ipe-mcp-id while preserving carrier custom metadata, so each
  // carrier and its wrapped object must share one identity.
  const identity = requestedIdentity ?? createObjectIdentity();
  attributes.custom = identity.custom;
  attributes["x-ipe-mcp-id"] = identity.id;
  if (xml.name === "group") {
    for (const child of xml.children ?? []) {
      if (child.type !== "element") continue;
      if (child.name === "group" && /^ipe-mcp:nested-id:object-[0-9a-f]{24}$/u.test(child.attributes?.custom ?? "")) {
        const nested = createObjectIdentity();
        (child.attributes ??= {}).custom = `ipe-mcp:nested-id:${nested.id}`;
        delete child.attributes["x-ipe-mcp-id"];
        const inner = child.children?.find((candidate): candidate is XmlElement => candidate.type === "element");
        if (inner) remapNestedObjectIdentities(inner, nested);
      } else if (["path", "text", "image", "group", "use"].includes(child.name)) {
        remapNestedObjectIdentities(child);
      }
    }
  }
}

function objectFromNested(document: DocumentIR, xml: XmlElement, layerId: string, forcedId?: string, allowCarrier = true): IpeObject {
  assertObjectContent(xml, { nested: true });
  const attributes = xml.attributes ?? {};
  const carrier = attributes.custom?.match(/^ipe-mcp:nested-id:(object-[0-9a-f]{24})$/u);
  if (allowCarrier && xml.name === "group" && carrier) {
    const unsupported = Object.keys(attributes).filter((name) => name !== "custom" && name !== "x-ipe-mcp-id");
    const elements = (xml.children ?? []).filter((child): child is XmlElement => child.type === undefined || child.type === "element");
    const nonWhitespace = (xml.children ?? []).filter((child) => child.type === "text" && child.text.trim() !== "");
    if (unsupported.length > 0 || elements.length !== 1 || nonWhitespace.length > 0) throw new Error("invalid nested identity carrier");
    return objectFromNested(document, elements[0]!, layerId, carrier[1]!, false);
  }
  const custom = attributes.custom;
  const persisted = attributes["x-ipe-mcp-id"];
  const identity = custom === undefined
    ? createObjectIdentity()
    : { custom, id: forcedId ?? persisted ?? objectIdFromCustom(custom) };
  assertPersistentEntityId("object", identity.id);
  const object: IpeObject = {
    id: identity.id,
    custom: identity.custom,
    layerId,
    zOrder: 0,
    ...(attributes.matrix === undefined ? {} : { matrix: parseOptionalMatrix(attributes.matrix)! }),
    ...(attributes.pin === undefined ? {} : { pin: attributes.pin }),
    ...(attributes.transformations === undefined ? {} : { transformationMode: attributes.transformations }),
    xml: cloneObject(xml),
  };
  const kind = objectKind(object);
  const references = nestedReferences(document, xml);
  if (references.length > 0) object.references = references;
  if (kind === "image") object.assetId = references[0]!.id;
  if (kind === "use") object.symbolId = references[0]!.id;
  return object;
}

function assertUniqueObjectIds(document: DocumentIR, pageId: string, objects: readonly IpeObject[]): void {
  const ids = new Set<string>();
  for (const page of document.pages) {
    for (const object of page.id === pageId ? objects : page.objects) {
      assertPersistentEntityId("object", object.id);
      if (ids.has(object.id)) throw new Error(`duplicate object ID '${object.id}'`);
      ids.add(object.id);
    }
  }
}

/** Apply a batch to a clone and swap only after every operation and invariant succeeds. */
export function applyObjectOperations(
  document: DocumentIR,
  pageId: string,
  operations: readonly ObjectOperation[],
): ObjectMutationResult {
  const page = pageById(document, pageId);
  const working = cloneObject(page.objects);
  const affected = new Set<string>();
  // Existing callers may hold imported/minimal documents which predate the
  // full domain contract (for example an omitted view).  Still run the full
  // validator on the candidate, but only newly introduced errors can make an
  // otherwise valid object transaction fail.
  const baselineValidation = validateDocument(document);
  const baselineDiagnostics = new Set(baselineValidation.errors.map((item) => `${item.code}|${item.message}`));
  const baselineHasUnresolvedSymbol = baselineValidation.errors.some((item) => item.code === "REF_UNRESOLVED" && item.message.includes("symbol"));

  for (const operation of operations) {
    switch (operation.op) {
      case "insert": {
        const object = cloneObject(operation.object);
        assertLayer(page, object.layerId);
        objectKind(object);
        assertObjectReferences(document, page, object, working);
        working.splice(insertionIndex(working, operation.position), 0, object);
        affected.add(object.id);
        break;
      }
      case "replace": {
        const index = indexOf(working, operation.objectId);
        const previous = working[index]!;
        const replacement = cloneObject(operation.replacement);
        assertLayer(page, replacement.layerId);
        objectKind(replacement);
        assertObjectReferences(document, page, replacement, working);
        if (operation.preserveIdentity ?? true) {
          replacement.id = previous.id;
          if (previous.custom === undefined) delete replacement.custom;
          else replacement.custom = previous.custom;
          replacement.layerId = previous.layerId;
        } else {
          // Validate against the post-replacement object set. Checking the
          // pre-replacement array lets a new object retain a dangling
          // reference to the object it is about to replace.
          const candidate = [...working];
          candidate[index] = replacement;
          assertObjectReferences(document, page, replacement, candidate);
          const hits = referencesTo(document, pageId, candidate, new Set([previous.id]));
          if (hits.length > 0) throw new Error(`object '${previous.id}' is still referenced by ${hits.join(", ")}`);
        }
        replacement.zOrder = index;
        working[index] = replacement;
        affected.add(previous.id);
        affected.add(replacement.id);
        break;
      }
      case "duplicate": {
        const sourceIndex = indexOf(working, operation.objectId);
        const duplicate = cloneObject(working[sourceIndex]!);
        const identity = operation.identity ?? createObjectIdentity();
        duplicate.id = identity.id;
        duplicate.custom = identity.custom;
        if (objectKind(duplicate) === "group") remapNestedObjectIdentities(duplicate.xml!, { id: duplicate.id, custom: duplicate.custom! });
        const position = operation.position ?? { kind: "after", objectId: operation.objectId } as const;
        working.splice(insertionIndex(working, position), 0, duplicate);
        affected.add(duplicate.id);
        break;
      }
      case "delete": {
        const index = indexOf(working, operation.objectId);
        const hits = referencesTo(document, pageId, working.filter((_, candidate) => candidate !== index), new Set([operation.objectId]));
        if (hits.length > 0) throw new Error(`object '${operation.objectId}' is still referenced by ${hits.join(", ")}`);
        working.splice(index, 1);
        affected.add(operation.objectId);
        break;
      }
      case "move": {
        const index = indexOf(working, operation.objectId);
        const [object] = working.splice(index, 1);
        // A before/after reference to the moved object is a valid no-op.
        const position = (operation.position.kind === "before" || operation.position.kind === "after")
          && operation.position.objectId === operation.objectId
          ? { kind: "index" as const, index }
          : operation.position;
        working.splice(insertionIndex(working, position), 0, object!);
        affected.add(operation.objectId);
        break;
      }
      case "layer": {
        assertLayer(page, operation.layerId);
        working[indexOf(working, operation.objectId)]!.layerId = operation.layerId;
        affected.add(operation.objectId);
        break;
      }
      case "group": {
        if (operation.objectIds.length < 2 || new Set(operation.objectIds).size !== operation.objectIds.length) {
          throw new Error("group requires at least two distinct objects");
        }
        const indices = operation.objectIds.map((id) => indexOf(working, id)).sort((a, b) => a - b);
        if (indices.some((value, offset) => value !== indices[0]! + offset)) throw new Error("grouped objects must be contiguous in z-order");
        const children = indices.map((index) => working[index]!);
        if (new Set(children.map((child) => child.layerId)).size !== 1) throw new Error("grouped objects must share one layer");
        const selected = new Set(operation.objectIds);
        const hits = referencesTo(document, pageId, working.filter((object) => !selected.has(object.id)), selected);
        if (hits.length > 0 || children.some((child) => (child.references ?? []).some((reference) => reference.kind === "object"))) {
          throw new Error("cannot group objects with object references: per-child references cannot be preserved");
        }
        const group = buildGroupObject({
          layerId: children[0]!.layerId,
          children,
          ...(operation.identity === undefined ? {} : { identity: operation.identity }),
          ...(operation.clip === undefined ? {} : { clip: operation.clip }),
          ...(operation.url === undefined ? {} : { url: operation.url }),
          ...(operation.decoration === undefined ? {} : { decoration: operation.decoration }),
        });
        working.splice(indices[0]!, indices.length, group);
        operation.objectIds.forEach((id) => affected.add(id));
        affected.add(group.id);
        break;
      }
      case "ungroup": {
        const index = indexOf(working, operation.objectId);
        const group = working[index]!;
        if (objectKind(group) !== "group") throw new Error(`object '${operation.objectId}' is not a group`);
        if ((group.references ?? []).some((reference) => reference.kind === "object")) {
          throw new Error("cannot ungroup: per-child object references cannot be preserved");
        }
        const hits = referencesTo(document, pageId, working.filter((_, candidate) => candidate !== index), new Set([group.id]));
        if (hits.length > 0) throw new Error(`object '${group.id}' is still referenced by ${hits.join(", ")}`);
        const attributes = group.xml!.attributes ?? {};
        const consumedAttributes = new Set(["layer", "matrix", "custom", "x-ipe-mcp-id"]);
        const unsupportedAttributes = Object.keys(attributes).filter((name) => !consumedAttributes.has(name));
        if (unsupportedAttributes.length > 0) {
          throw new Error(`cannot ungroup: group attribute '${unsupportedAttributes[0]}' cannot be preserved`);
        }
        if (attributes.clip !== undefined || attributes.url !== undefined || attributes.decoration !== undefined
          || group.pin !== undefined || group.transformationMode !== undefined) {
          throw new Error("cannot ungroup while clip, link, decoration, pin or transformation policy is active");
        }
        const children: XmlElement[] = [];
        for (const child of group.xml!.children ?? []) {
          if (child.type === undefined || child.type === "element") {
            children.push(child);
          } else if (child.type !== "text" || child.text.trim() !== "") {
            throw new Error("cannot ungroup: non-element group content cannot be preserved");
          }
        }
        if (children.length === 0) throw new Error("group has no object children");
        const objects = children.map((child) => objectFromNested(document, child, group.layerId));
        if (group.matrix !== undefined) {
          for (const child of objects) child.matrix = multiplyMatrices(group.matrix, child.matrix ?? IDENTITY_MATRIX);
        }
        working.splice(index, 1, ...objects);
        affected.add(group.id);
        objects.forEach((object) => affected.add(object.id));
        break;
      }
    }
    normalizeZOrder(working);
    assertUniqueObjectIds(document, pageId, working);
  }

  const candidate = cloneObject(document);
  const candidatePage = candidate.pages.find((item) => item.id === pageId);
  if (!candidatePage) throw new Error(`page '${pageId}' does not exist`);
  candidatePage.objects = working;
  const validation = validateDocument(candidate);
  const newErrors = validation.errors.filter((item) =>
    !baselineDiagnostics.has(`${item.code}|${item.message}`)
    && !(baselineHasUnresolvedSymbol && item.code === "REF_UNRESOLVED" && item.message.includes("symbol")));
  if (newErrors.length > 0) {
    throw new Error(`object operation validation failed: ${newErrors.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  }
  // The caller is mutated only after every operation and the full document
  // candidate has passed validation.
  page.objects = working;
  return { pageId, affectedObjectIds: [...affected], objectIdsBackToFront: working.map((object) => object.id) };
}
