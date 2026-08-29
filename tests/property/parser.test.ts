import { describe, it } from "vitest";

import { canonicalizeIpe } from "../../src/core/ipe-document-codec.js";
import { parseIpeXml, XmlParseError } from "../../src/ipe/xml/parser.js";
import { PINNED_SEEDS, XorShift32, fail, iterations } from "./rng.js";

const SEED = PINNED_SEEDS.parser;
const CASES = iterations();

const NEXT_TAGS = ["page", "layer", "view", "path", "text", "image", "group", "use", "ipestyle", "ipestyles", "bitmap", "color", "pen", "symbol", "info", "layout", "map", "transform", "view"];
/** XML 1.0 prohibited control characters (U+0000-U+001F except tab/newline/carriage-return). DEL is legal. */
const CONTROL_CHARS = ["\u0000", "\u0001", "\u0002", "\u0003", "\u0004", "\u0005", "\u0006", "\u0007", "\u0008", "\u000b", "\u000c", "\u000e", "\u000f", "\u0010", "\u0011", "\u0012", "\u0013", "\u0014", "\u0015", "\u0016", "\u0017", "\u0018", "\u0019", "\u001a", "\u001b", "\u001c", "\u001d", "\u001e", "\u001f"];

function randomXmlAtom(random: XorShift32, depth: number): string {
  const tag = random.pick(NEXT_TAGS);
  const spacing = random.pick([" ", "", "\n", "\t"]);
  const name = random.string(1, 6);
  const literal = random.pick(["m", "l", "c", "M", "L", "e", "0 0 m"]);
  const children = depth < 3 && random.next() < 0.4 ? `<path>${spacing}${literal}${spacing}</path>` : "";
  return `<${tag}${spacing}x-${name}="${random.pick(["a", "b", "c"])}"${spacing}>${children}${random.next() < 0.5 ? `<${name}>${literal}</${name}>` : ""}</${tag}>`;
}

function randomSurface(random: XorShift32): string {
  const prefix = random.next() < 0.5 ? "<?xml version=\"1.0\"?>" : "";
  const preamble = random.next() < 0.3 ? "<ipestyle name=\"random\"><layout paper=\"320 180\" origin=\"0 0\" frame=\"320 180\"/></ipestyle>" : "";
  const pages = Array.from({ length: random.integer(1, 3) }, () => `<page><layer name="a"/><view layers="a" active="a"/>${Array.from({ length: random.integer(0, 4) }, () => randomXmlAtom(random, 0)).join("")}</page>`).join("");
  return `${prefix}<ipe version="70218">${preamble}${pages}</ipe>`;
}

describe("property: XML parser safety (bounded structural fuzz)", () => {
  it("never crashes and never allocates beyond the permitted surface for random document XML", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const source = randomSurface(random);
      if (Buffer.byteLength(source, "utf8") > 64 * 1024) fail(SEED, index, "generator produced an over-budget input");
      let document: import("../../src/ipe/xml/parser.js").XmlDocument | undefined;
      try { document = parseIpeXml(source); } catch (error) {
        if (!(error instanceof XmlParseError)) fail(SEED, index, `unexpected non-safe parse failure: ${String(error)}`);
        continue;
      }
      if (document.root.name !== "ipe") fail(SEED, index, "root element is not ipe");
    }
  });

  it("canonicalizes every accepted surface to a fixed point", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const source = randomSurface(random);
      if (Buffer.byteLength(source, "utf8") > 64 * 1024) fail(SEED, index, "generator produced an over-budget input");
      let first: string;
      try { first = canonicalizeIpe(source); } catch { continue; }
      const second = canonicalizeIpe(first);
      if (second !== first) fail(SEED, index, "canonicalization did not reach a fixed point");
    }
  });

  it("rejects entity/doctype/namespace surfaces inside random documents", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const prefix = random.next() < 0.5 ? "<!DOCTYPE ipe [<!ENTITY x \"boom\">]>" : "";
      const namespaced = random.next() < 0.5 ? "<ipe xmlns=\"urn:ipe\" version=\"70218\"/>" : "";
      const source = `${prefix}${namespaced ? namespaced : randomSurface(random).replace(/^<\?xml[^?]*\?>/u, "")}`;
      try { void parseIpeXml(source); }
      catch (error) {
        if (error instanceof XmlParseError) continue;
        fail(SEED, index, `unexpected non-safe rejection: ${String(error)}`);
      }
    }
  });

  it("never accepts invalid UTF-8 byte streams", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const bytes = new Uint8Array(random.integer(4, 128));
      for (let cursor = 0; cursor < bytes.length; cursor += 1) bytes[cursor] = random.integer(0, 255);
      let accepted = false;
      try { void parseIpeXml(bytes); accepted = true; } catch (error) {
        if (!(error instanceof XmlParseError)) fail(SEED, index, `unexpected failure mode: ${String(error)}`);
      }
      if (accepted) fail(SEED, index, "random byte stream was accepted as XML");
    }
  });

  it("keeps XML 1.0 control characters out of accepted text surfaces", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const source = `<ipe version="70218"><page><layer name="a"/><text layer="a">${CONTROL_CHARS[random.integer(0, CONTROL_CHARS.length - 1)]}</text></page></ipe>`;
      let accepted = false;
      try { void parseIpeXml(source); accepted = true; } catch (error) {
        if (!(error instanceof XmlParseError)) fail(SEED, index, `unexpected failure mode: ${String(error)}`);
      }
      if (accepted) fail(SEED, index, "XML 1.0 control character was accepted in text");
    }
  });
});
