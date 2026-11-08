import { SaxesParser } from "saxes";

import type { Matrix } from "../domain/ir.js";
import { multiplyMatrices } from "../layout/matrix.js";
import { compilePath } from "../objects/path.js";
import { rejectImport } from "./errors.js";
import { parseSvgPath, svgNumberList } from "./svg-path.js";

/** Parse only the local glyph paths and references emitted by the MuPDF SVG device. */
export function glyphOutlines(svg: string, origin: Matrix, location: string): { matrix: Matrix; path: string }[] {
  const parser = new SaxesParser({ xmlns: false });
  const definitions = new Map<string, string>();
  const stack: string[] = [];
  const outlines: { matrix: Matrix; path: string }[] = [];
  let uses = 0;
  const fail = () => rejectImport("PDF_GLYPH_OUTLINE_UNSUPPORTED", location);
  parser.on("error", fail);
  parser.on("doctype", fail);
  parser.on("processinginstruction", fail);
  parser.on("cdata", fail);
  parser.on("text", (text) => { if (text.trim() !== "") fail(); });
  parser.on("opentag", ({ name, attributes }) => {
    const parent = stack.at(-1);
    stack.push(name);
    const allowed = parent === undefined && name === "svg" ? ["xmlns", "xmlns:xlink", "xmlns:inkscape", "version", "width", "height", "viewBox"]
      : parent === "svg" && name === "defs" ? []
      : parent === "defs" && name === "path" ? ["id", "d"]
      : parent === "svg" && name === "use" ? ["data-text", "xlink:href", "transform", "fill"] : fail();
    if (Object.keys(attributes).some((key) => !allowed.includes(key))) fail();
    if (name === "path") {
      const { id, d } = attributes;
      if (id === undefined || d === undefined || !/^font_\d+_\d+$/u.test(id) || definitions.has(id) || definitions.size >= 1000) return fail();
      if (d.trim() === "") {
        definitions.set(id, "");
        return;
      }
      const child = compilePath({ kind: "raw", subpaths: parseSvgPath(d, location) }).children?.[0];
      if (child?.type !== "text") return fail();
      definitions.set(id, child.text.trim());
    } else if (name === "use") {
      const href = attributes["xlink:href"];
      const transform = /^matrix\(([^()]*)\)$/u.exec(attributes.transform ?? "");
      if (++uses > 4000 || !href?.startsWith("#") || transform === null) return fail();
      const path = definitions.get(href.slice(1));
      const numbers = svgNumberList(transform[1]!, location);
      if (path === undefined || numbers.length !== 6) return fail();
      if (path !== "") outlines.push({ matrix: multiplyMatrices(origin, numbers as unknown as Matrix), path });
    }
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(svg).close();
  if (outlines.length === 0) return fail();
  return outlines;
}
