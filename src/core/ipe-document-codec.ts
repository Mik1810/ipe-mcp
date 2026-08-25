import type { DocumentIR } from "../domain/ir.js";
import { validateDocument } from "../domain/validate.js";
import { parseIpeXml } from "../ipe/xml/parser.js";
import { projectXml, type ProjectedDocument } from "../ipe/xml/project.js";
import { serializeXml } from "../ipe/xml/serializer.js";
import type { DocumentCodec } from "../persistence/session-manager.js";

/** The production structural codec shared by sessions and transport adapters. */
export const ipeDocumentCodec: DocumentCodec<ProjectedDocument> = {
  parse(source) {
    return projectXml(parseIpeXml(source));
  },
  serialize(document) {
    return serializeXml(document);
  },
  validate(document) {
    return validateDocument(document).diagnostics;
  },
};

export function canonicalizeIpe(source: string | Uint8Array): string {
  const document = ipeDocumentCodec.parse(source);
  const diagnostics = ipeDocumentCodec.validate(document);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`Ipe structural validation failed: ${errors.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  }
  return ipeDocumentCodec.serialize(document);
}

export type IpeDocument = DocumentIR & ProjectedDocument;
