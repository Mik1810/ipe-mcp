import type { DocumentIR, IpeObject, ObjectReference } from "../domain/ir.js";
import type { XmlElement } from "../domain/xml-node.js";
import { isXmlElement } from "../domain/xml-node.js";
import { IPE_OBJECT_KINDS } from "./common.js";
import { assertObjectContent } from "./content-model.js";

const supportedObjectTags = new Set<string>(IPE_OBJECT_KINDS);

/**
 * Walk an object XML subtree, rejecting object tags that this milestone
 * cannot preserve and collecting the references which can be identified
 * without interpreting the object's other attributes.
 *
 * When a document is supplied, every nested image is also resolved through
 * the document's native bitmap-id mapping.  This is deliberately the one
 * recursive walker used by builders, CRUD, and domain validation so imported
 * groups cannot silently bypass the same checks as newly-built groups.
 */
export function walkNestedObjectXml(xml: XmlElement, document?: DocumentIR): ObjectReference[] {
  assertObjectContent(xml);
  const references: ObjectReference[] = [];
  const walk = (node: XmlElement, path: string): void => {
    if (!supportedObjectTags.has(node.name)) throw new Error(`unsupported object tag '${node.name}' at ${path}`);
    if (node.name === "image") {
      const bitmap = node.attributes?.bitmap;
      if (document !== undefined) {
        const asset = (document.assets ?? []).find((candidate) => candidate.xml?.attributes?.id === bitmap);
        if (!asset) throw new Error(`nested image bitmap '${bitmap ?? "missing"}' does not resolve`);
        references.push({ kind: "asset", id: asset.id });
      }
    } else if (node.name === "use") {
      const symbol = node.attributes?.name;
      if (!symbol) throw new Error("nested symbol use has no name");
      references.push({ kind: "symbol", id: symbol });
    } else if (node.name === "group" && node.attributes?.decoration !== undefined) {
      references.push({ kind: "symbol", id: node.attributes.decoration });
    }
    for (const [index, child] of (node.children ?? []).entries()) {
      if (isXmlElement(child)) walk(child, `${path}.children[${index}]`);
    }
  };
  walk(xml, "xml");
  return references;
}

/** Collect references embedded in an object XML subtree and resolve bitmaps to managed asset IDs. */
export function nestedReferences(document: DocumentIR, xml: XmlElement): NonNullable<IpeObject["references"]> {
  return walkNestedObjectXml(xml, document);
}

/** Collect only statically identifiable symbol references for raw XML builders. */
export function nestedSymbolReferences(xml: XmlElement): ObjectReference[] {
  return walkNestedObjectXml(xml).filter((reference) => reference.kind === "symbol");
}
