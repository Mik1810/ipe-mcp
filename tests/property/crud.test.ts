import { describe, it } from "vitest";

import type { DocumentIR, IpeObject } from "../../src/domain/ir.js";
import { validateDocument } from "../../src/domain/validate.js";
import { applyObjectOperations, type ObjectOperation } from "../../src/objects/crud.js";
import { buildPathObject } from "../../src/objects/builders.js";
import { createObjectIdentity } from "../../src/objects/common.js";
import { PINNED_SEEDS, XorShift32, fail, iterations } from "./rng.js";

const SEED = PINNED_SEEDS.crud;
const CASES = iterations();
const layerId = "layer-000000000000000000000001";
const pageId = "page-000000000000000000000001";

function documentWith(objects: IpeObject[]): DocumentIR {
  return {
    schemaVersion: 1,
    format: 70218,
    pages: [{
      id: pageId,
      layers: [{ id: layerId, name: "LayerOne" }],
      views: [{ id: "view-000000000000000000000001", visibleLayerIds: [layerId], activeLayerId: layerId, marked: false }],
      objects,
    }],
  };
}

function freshPath(random: XorShift32, index: number): IpeObject {
  const x = random.between(-500, 500);
  return buildPathObject({
    layerId,
    identity: createObjectIdentity(`00000000-0000-5000-8000-${String(index).padStart(12, "0")}`),
    path: { kind: "segment", from: { x, y: 0 }, to: { x: x + 1, y: 1 } },
  });
}

function assertInvariants(document: DocumentIR, caseIndex: number): void {
  const { errors } = validateDocument(document);
  const blocking = errors.filter((item) => item.severity === "error");
  if (blocking.length > 0) fail(SEED, caseIndex, `invariant violated: ${blocking.map((item) => item.code).join(", ")}`);
  const page = document.pages[0]!;
  page.objects.forEach((object, index) => {
    if (object.zOrder !== index) fail(SEED, caseIndex, `zOrder ${object.zOrder} != sequence ${index}`);
  });
  const ids = page.objects.map((object) => object.id);
  if (new Set(ids).size !== ids.length) fail(SEED, caseIndex, "duplicate object IDs");
  for (const object of page.objects) {
    if (!page.layers.some((layer) => layer.id === object.layerId)) fail(SEED, caseIndex, "object references an unknown layer");
    for (const reference of object.references ?? []) {
      if (reference.kind === "object" && !ids.includes(reference.id)) fail(SEED, caseIndex, `dangling object reference ${reference.id}`);
      if (reference.kind === "asset" && !(document.assets ?? []).some((asset) => asset.id === reference.id)) fail(SEED, caseIndex, `dangling asset reference ${reference.id}`);
    }
  }
}

function fingerprint(object: IpeObject): string {
  return `${object.id}|${object.zOrder}|${object.layerId}`;
}

describe("property: CRUD batch atomicity and reference invariants", () => {
  it("keeps every committed batch invariant-clean for random sequence sizes", () => {
    const random = new XorShift32(SEED);
    for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
      const document = documentWith([]);
      const operations: ObjectOperation[] = [];
      for (let step = 0; step < 8; step += 1) {
        operations.push({ op: "insert", object: freshPath(random, step), position: { kind: "back" } });
      }
      applyObjectOperations(document, pageId, operations);
      assertInvariants(document, caseIndex);
      const after = document.pages[0]!.objects;
      if (after.length !== operations.length) fail(SEED, caseIndex, "inserted count diverged");
      if (after.some((object, index) => object.zOrder !== index)) fail(SEED, caseIndex, "insert sequence z-order diverged");
    }
  });

  it("preserves identity through replacement and keeps references valid", () => {
    const random = new XorShift32(SEED);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const firsts = [freshPath(random, 0), freshPath(random, 1), freshPath(random, 2)];
      const document = documentWith([]);
      applyObjectOperations(document, pageId, firsts.map((object) => ({ op: "insert" as const, object, position: { kind: "back" } })));
      const target = firsts[random.integer(0, firsts.length - 1)]!;
      applyObjectOperations(document, pageId, [{ op: "replace", objectId: target.id, replacement: freshPath(random, 100 + caseIndex) }]);
      const stillThere = document.pages[0]!.objects.find((object) => object.id === target.id);
      if (stillThere === undefined) fail(SEED, caseIndex, "replacement lost the target identity");
      if (stillThere!.xml?.name !== "path") fail(SEED, caseIndex, "replacement content is not the new path");
      assertInvariants(document, caseIndex);
    }
  });

  it("rolls back the whole batch atomically when a later operation is invalid", () => {
    const random = new XorShift32(SEED);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const firsts = [freshPath(random, 0), freshPath(random, 1)];
      const document = documentWith([]);
      applyObjectOperations(document, pageId, firsts.map((object) => ({ op: "insert" as const, object, position: { kind: "back" } })));
      const before = document.pages[0]!.objects.map(fingerprint);
      let threw = false;
      try {
        applyObjectOperations(document, pageId, [
          { op: "insert", object: freshPath(random, 200 + caseIndex), position: { kind: "back" } },
          { op: "replace", objectId: "object-000000000000000000000049", replacement: freshPath(random, 300 + caseIndex) },
        ]);
      } catch { threw = true; }
      if (!threw) fail(SEED, caseIndex, "invalid batch did not throw");
      const after = document.pages[0]!.objects.map(fingerprint);
      if (JSON.stringify(after) !== JSON.stringify(before)) fail(SEED, caseIndex, "partial write leaked from a failed batch");
    }
  });

  it("supports random interleaved move/duplicate batches without losing invariants", () => {
    const random = new XorShift32(SEED);
    for (let caseIndex = 0; caseIndex < 32; caseIndex += 1) {
      const firsts = Array.from({ length: 4 }, (_, index) => freshPath(random, index));
      const document = documentWith([]);
      applyObjectOperations(document, pageId, firsts.map((object) => ({ op: "insert" as const, object, position: { kind: "back" } })));
      const before = document.pages[0]!.objects.map(fingerprint);
      const operations: ObjectOperation[] = [];
      for (let step = 0; step < 6; step += 1) {
        const target = document.pages[0]!.objects[random.integer(0, document.pages[0]!.objects.length - 1)]!;
        operations.push(random.next() < 0.5
          ? { op: "move", objectId: target.id, position: random.pick([{ kind: "back" }, { kind: "front" }] as const) }
          : { op: "duplicate", objectId: target.id, position: { kind: "back" } });
      }
      try {
        applyObjectOperations(document, pageId, operations);
      } catch {
        assertInvariants(document, caseIndex);
        continue;
      }
      assertInvariants(document, caseIndex);
      const after = document.pages[0]!.objects.map(fingerprint);
      if (new Set([...after]).size !== after.length) fail(SEED, caseIndex, "duplicate produced colliding fingerprints");
      if (JSON.stringify(after) === JSON.stringify(before)) fail(SEED, caseIndex, "interleaved batch was a no-op");
    }
  });
});
