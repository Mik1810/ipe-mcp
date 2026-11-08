import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import { importSvg } from "../../src/import/svg.js";
import { parseSvgPath } from "../../src/import/svg-path.js";
import { IpeMcpService } from "../../src/mcp/service.js";
import { NATIVE_PROCESS_LIMITS } from "../../src/limits.js";
import { runControlledProcess } from "../../src/native/process.js";

const fixture = "fixtures/conformance/m10/import/editable.svg";
const quadrants = new PNG({ width: 40, height: 40 });
for (let y = 0; y < 40; y++) {
  for (let x = 0; x < 40; x++) {
    const top = y < 20, left = x < 20;
    quadrants.data.set([left ? 255 : 0, top ? 255 : 0, !top && !left ? 255 : 0, 255], (y * 40 + x) * 4);
  }
}
const png = PNG.sync.write(quadrants);

const svg = (body: string) => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="96" viewBox="10 20 60 60">' + body + "</svg>");

describe("SVG vector import", () => {
  it("keeps viewBox alignment, inherited paint, transform order and source z-order", () => {
    const document = importSvg(svg('<g transform="translate(2 3) scale(2)" fill="#f00"><rect x="10" y="20" width="5" height="4"/><circle cx="20" cy="30" r="2" fill="#0000ff"/></g>'));
    const page = document.pages[0]!;
    expect(page.objects.map(({ xml, zOrder, matrix }) => [xml?.attributes?.fill, zOrder, matrix])).toEqual([
      ["1 0 0", 0, [2.4, 0, 0, -2.4, -0.6, 92.4]],
      ["0 0 1", 1, [2.4, 0, 0, -2.4, -0.6, 92.4]],
    ]);
  });

  it("preserves repeated relative segments, smooth cubic controls and an elliptical arc", () => {
    const [part] = parseSvgPath("M1 2 c3 4 5 6 7 8 s2 3 4 5 a6 8 0 0 1 2 3", "svg.child[0]");
    expect(part?.commands).toEqual([
      { op: "m", point: { x: 1, y: 2 } },
      { op: "c", control1: { x: 4, y: 6 }, control2: { x: 6, y: 8 }, to: { x: 8, y: 10 } },
      { op: "c", control1: { x: 10, y: 12 }, control2: { x: 10, y: 13 }, to: { x: 12, y: 15 } },
      { op: "a", matrix: expect.any(Array), to: { x: 14, y: 18 } },
    ]);
  });

  it.each([
    ['<rect width="5" height="5"/><script/>', "SVG_ACTIVE_CONTENT"],
    ['<rect width="5" height="5" onload="secret()"/>', "SVG_ACTIVE_CONTENT"],
    ['<image href="https://example.invalid/hidden"/>', "SVG_IMAGE_REFERENCE_UNSUPPORTED"],
    ['<rect width="5" height="5" fill="url(https://example.invalid/hidden)"/>', "SVG_PAINT_SERVER_UNSUPPORTED"],
    ['<rect width="5" height="5" clip-path="url(#clip)"/>', "SVG_EFFECT_UNSUPPORTED"],
    ['<text x="1" y="1">hello</text>', "SVG_TEXT_UNSUPPORTED"],
    ['<g opacity="0.5"><circle r="2"/></g>', "SVG_OPACITY_UNSUPPORTED"],
    ['<line x2="5" stroke="black" transform="scale(2 1)"/>', "SVG_AFFINE_STROKE_UNSUPPORTED"],
    ['<path d="M0,0,,L1 1"/>', "SVG_INVALID_SEPARATOR"],
  ])("rejects unsupported or malformed input without returning partial geometry", (source, code) => {
    expect(() => importSvg(svg(source))).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code }) }));
  });

  it("rejects PNG extensions, trailing payloads and excessive declared pixels before decoding", () => {
    const unsupportedChunk = Buffer.from(png);
    unsupportedChunk.write("gAMA", 37, "ascii");
    const wideSamples = Buffer.from(png);
    wideSamples[24] = 16;
    const interlaced = Buffer.from(png);
    interlaced[28] = 1;
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(1_000_001, 16);
    for (const [bytes, code] of [
      [unsupportedChunk, "SVG_PNG_CHUNK_UNSUPPORTED"],
      [Buffer.concat([png, Buffer.from("canary")]), "SVG_INVALID_PNG"],
      [oversized, "SVG_IMAGE_PIXEL_LIMIT"],
      [interlaced, "SVG_PNG_INTERLACE_UNSUPPORTED"],
      [wideSamples, "SVG_PNG_BIT_DEPTH_UNSUPPORTED"],
    ] as const) {
      const image = '<image width="5" height="5" href="data:image/png;base64,' + bytes.toString("base64") + '"/>';
      expect(() => importSvg(svg(image))).toThrow(expect.objectContaining({ diagnostic: { code, location: "svg.child[0]" } }));
    }
  });

  it("rejects DTD and processing instructions without disclosing their payload", () => {
    for (const [prefix, code] of [
      ['<!DOCTYPE svg [<!ENTITY test SYSTEM "file:///private/canary">]>', "SVG_DTD_FORBIDDEN"],
      ['<?xml-stylesheet type="text/css" href="file:///private/canary"?>', "SVG_PROCESSING_INSTRUCTION"],
    ] as const) {
      expect(() => importSvg(Buffer.concat([Buffer.from(prefix), svg('<rect width="5" height="5"/>')])))
        .toThrow(expect.objectContaining({ diagnostic: { code, location: "svg" } }));
    }
  });
});

describe.skipIf(process.platform !== "linux")("SVG native pipeline", () => {
  it("preserves the orientation and z-order of an embedded PNG in the native preview", async () => {
    const work = await mkdtemp(join(tmpdir(), "ipe-svg-image-"));
    try {
      const service = await IpeMcpService.create([work], join(work, "state"));
      const source = Buffer.from('<svg width="40pt" height="40pt" viewBox="0 0 40 40"><rect width="40" height="40"/>'
        + '<image width="40" height="40" href="data:image/png;base64,' + png.toString("base64")
        + '"/><rect x="18" y="18" width="4" height="4" fill="white"/></svg>');
      const imported = await service.importSvgDocument(source.toString("base64"));
      const [preview] = await service.render(imported.documentId);
      const actual = PNG.sync.read(preview!.data);
      expect([actual.width, actual.height]).toEqual([40, 40]);
      const pixel = (x: number, y: number) => [...actual.data.subarray((y * actual.width + x) * 4, (y * actual.width + x) * 4 + 3)];
      expect([pixel(8, 8), pixel(32, 8), pixel(8, 32), pixel(32, 32), pixel(20, 20)]).toEqual([
        [255, 255, 0], [0, 255, 0], [255, 0, 0], [0, 0, 255], [255, 255, 255],
      ]);
      expect((await service.validate(imported.documentId, "full")).ok).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15000);

  it("matches an independent renderer and preserves IDs through validation, save, reload and PDF export", async () => {
    const work = await mkdtemp(join(tmpdir(), "ipe-svg-import-"));
    try {
      const service = await IpeMcpService.create([work], join(work, "state"));
      const source = await readFile(fixture);
      const imported = await service.importSvgDocument(source.toString("base64"));
      const original = await service.originalResource(imported.documentId);
      expect(original.data).toEqual(source);
      const output = join(work, "reference.png");
      await runControlledProcess("/usr/bin/mutool", ["draw", "-q", "-F", "png", "-r", "72", "-o", output, resolve(fixture)], work,
        NATIVE_PROCESS_LIMITS, "NATIVE_RENDER_ERROR");
      const expected = PNG.sync.read(await readFile(output));
      const [preview] = await service.render(imported.documentId);
      const actual = PNG.sync.read(preview!.data);
      expect([actual.width, actual.height]).toEqual([160, 96]);
      expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
      const pixel = (x: number, y: number) => Array.from(actual.data.subarray((y * actual.width + x) * 4, (y * actual.width + x) * 4 + 3));
      expect(pixel(71, 48)[0]).toBeGreaterThan(180); // red circle covers the blue rectangle
      expect(pixel(118, 27)[0]).toBeGreaterThan(220); // closed ellipse from two SVG arc commands
      expect(pixel(118, 27)[2]).toBeLessThan(120);
      let different = 0;
      for (let offset = 0; offset < actual.data.length; offset += 4) {
        if ([0, 1, 2].some((c) => Math.abs(actual.data[offset + c]! - expected.data[offset + c]!) > 32)) different++;
      }
      expect(different).toBeLessThanOrEqual(32);
      expect((await service.validate(imported.documentId, "full")).ok).toBe(true);
      const target = join(work, "saved.ipe");
      await service.save(imported.documentId, 0, target);
      const reloaded = await service.openDocument(target);
      expect(reloaded.outline).toEqual(imported.outline);
      const [pdf] = await service.export(reloaded.documentId, "pdf");
      expect(pdf?.data.subarray(0, 5).toString()).toBe("%PDF-");
      expect(ipeDocumentCodec.parse(await readFile(target)).pages[0]?.objects).toHaveLength(4);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15000);
});
