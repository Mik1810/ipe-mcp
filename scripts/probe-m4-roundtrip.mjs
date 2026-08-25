#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { ipeDocumentCodec } from "../dist/src/core/ipe-document-codec.js";
import { applyObjectOperations } from "../dist/src/objects/crud.js";

const path = process.argv[2];
if (!path) throw new Error("usage: probe-m4-roundtrip NATIVE.ipe");
const document = ipeDocumentCodec.parse(await readFile(path));
const objects = document.pages.flatMap((page) => page.objects);

const image = objects.find((object) => object.xml?.name === "image");
const symbol = objects.find((object) => object.xml?.name === "use");
const clipped = objects.find((object) => object.xml?.name === "group" && object.xml.attributes?.clip !== undefined);
if (!image?.assetId || image.references?.[0]?.kind !== "asset") throw new Error("top-level image asset reference was not rehydrated");
if (!symbol?.symbolId || symbol.references?.[0]?.kind !== "symbol") throw new Error("symbol reference was not rehydrated");
if (clipped?.references?.[0]?.kind !== "asset") throw new Error("nested image reference was not rehydrated on its group");

const page = document.pages[0];
if (!page) throw new Error("native reload did not preserve the first page");
const group = page.objects.find((object) => object.xml?.name === "group" && object.xml.attributes?.clip === undefined);
if (!group?.xml) throw new Error("identity-carrier group missing");
const expected = (group.xml.children ?? []).flatMap((child) => {
  if (child.type !== "element") return [];
  const match = child.attributes?.custom?.match(/^ipe-mcp:nested-id:(object-[0-9a-f]{24})$/u);
  return match ? [match[1]] : [];
});
if (expected.length !== 2) throw new Error("native reload did not preserve two nested identity carriers");
applyObjectOperations(document, page.id, [{ op: "ungroup", objectId: group.id }]);
const actual = page.objects.filter((object) => expected.includes(object.id)).map((object) => object.id);
if (actual.join("\0") !== expected.join("\0")) throw new Error(`native nested identity mismatch: expected=${expected}, actual=${actual}`);
console.log("M4_ROUNDTRIP_REFERENCES=PASS");
console.log("M4_ROUNDTRIP_NESTED_IDENTITIES=PASS");
