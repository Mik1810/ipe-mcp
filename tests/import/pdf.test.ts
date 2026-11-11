import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { importPdf } from "../../src/import/pdf.js";
import { IpeMcpService } from "../../src/mcp/service.js";
import { NATIVE_PROCESS_LIMITS } from "../../src/limits.js";
import { runControlledProcess } from "../../src/native/process.js";
import { pdfFixture, pdfMixedFixture, PDF_VECTOR_CONTENT } from "./pdf-fixture.js";

describe.skipIf(process.platform !== "linux")("PDF import", () => {
  it("matches MuPDF and preserves editable geometry through the native pipeline", async () => {
    const work = await mkdtemp(join(tmpdir(), "ipe-pdf-fixture-"));
    try {
      const source = pdfFixture(PDF_VECTOR_CONTENT, { compressed: true });
      const input = join(work, "source.pdf"), reference = join(work, "reference.png");
      await writeFile(input, source);
      await runControlledProcess("/usr/bin/mutool", ["draw", "-q", "-F", "png", "-r", "72", "-o", reference, input], work,
        NATIVE_PROCESS_LIMITS, "NATIVE_RENDER_ERROR");
      const expected = PNG.sync.read(await readFile(reference));
      const service = await IpeMcpService.create([work], join(work, "state"));
      const imported = await service.importPdfDocument(source.toString("base64"));
      const original = await service.originalResource(imported.documentId);
      expect(original.data).toEqual(source);
      const [preview] = await service.render(imported.documentId);
      const actual = PNG.sync.read(preview!.data);
      expect([actual.width, actual.height]).toEqual([160, 96]);
      expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
      const pixel = (x: number, y: number) => [...actual.data.subarray((y * actual.width + x) * 4, (y * actual.width + x) * 4 + 3)];
      expect(pixel(74, 48)[0]).toBeGreaterThan(180); // red curve covers the blue rectangle
      expect(pixel(94, 48)).toEqual([255, 255, 255]); // clipped section
      let different = 0;
      for (let offset = 0; offset < actual.data.length; offset += 4) {
        if ([0, 1, 2].some((c) => Math.abs(actual.data[offset + c]! - expected.data[offset + c]!) > 32)) different++;
      }
      expect(different).toBeLessThanOrEqual(96);
      expect((await service.validate(imported.documentId, "full")).ok).toBe(true);
      const saved = join(work, "import.ipe");
      await service.save(imported.documentId, 0, saved);
      const reloaded = await service.openDocument(saved);
      expect(reloaded.outline).toEqual(imported.outline);
      const [pdf] = await service.export(reloaded.documentId, "pdf");
      expect(pdf?.data.subarray(0, 5).toString()).toBe("%PDF-");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15000);

  it("matches glyph outlines and bitmap paint order and recovers the original and diagnostics", async () => {
    const work = await mkdtemp(join(tmpdir(), "ipe-pdf-mixed-"));
    try {
      const source = pdfMixedFixture();
      expect(await readFile("fixtures/conformance/m10/import/mixed.pdf")).toEqual(source);
      const input = join(work, "source.pdf"), reference = join(work, "reference.png");
      await writeFile(input, source);
      await runControlledProcess("/usr/bin/mutool", ["draw", "-q", "-F", "png", "-r", "72", "-o", reference, input], work,
        NATIVE_PROCESS_LIMITS, "NATIVE_RENDER_ERROR");
      const expected = PNG.sync.read(await readFile(reference));
      const stateRoot = join(work, "state");
      const service = await IpeMcpService.create([work], stateRoot);
      const imported = await service.importPdfDocument(source.toString("base64"));
      expect(imported.diagnostics.map(({ code }) => code)).toEqual(["PDF_TEXT_OUTLINED", "PDF_IMAGE_INTERPOLATION_RENDERER_DEPENDENT"]);
      const [preview] = await service.render(imported.documentId);
      const actual = PNG.sync.read(preview!.data);
      expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
      const pixel = (x: number, y: number) => [...actual.data.subarray((y * actual.width + x) * 4, (y * actual.width + x) * 4 + 3)];
      expect([pixel(12, 20), pixel(42, 20), pixel(12, 50), pixel(42, 50), pixel(28, 36)]).toEqual([
        [255, 255, 0], [0, 255, 0], [255, 0, 0], [0, 0, 255], [255, 255, 255],
      ]);
      let expectedText = 0, actualText = 0, differentText = 0;
      for (let y = 28; y < 57; y++) {
        for (let x = 58; x < 150; x++) {
          const offset = (y * actual.width + x) * 4;
          const expectedPaint = expected.data[offset]! < 180, actualPaint = actual.data[offset]! < 180;
          expectedText += Number(expectedPaint);
          actualText += Number(actualPaint);
          differentText += Number(expectedPaint !== actualPaint);
        }
      }
      expect(expectedText).toBeGreaterThan(200);
      expect(actualText).toBeGreaterThan(200);
      expect(differentText).toBeLessThanOrEqual(110);
      expect((await service.validate(imported.documentId, "full")).ok).toBe(true);
      const destination = join(work, "import.ipe");
      await service.save(imported.documentId, 0, destination);

      const restarted = await IpeMcpService.create([work], stateRoot);
      expect(await restarted.recover()).toContainEqual({ documentId: imported.documentId, revision: 0 });
      const original = await restarted.originalResource(imported.documentId);
      expect(original.data).toEqual(source);
      expect(original.receipt.sha256).toBe(imported.source.sha256);
      expect(JSON.parse(restarted.documentResource(imported.documentId, "diagnostics").text).diagnostics).toEqual(imported.diagnostics);
      const reloaded = await restarted.openDocument(destination);
      expect(reloaded.outline).toEqual(imported.outline);
      expect((await restarted.export(reloaded.documentId, "pdf"))[0]?.data.subarray(0, 5).toString()).toBe("%PDF-");
      await writeFile(join(stateRoot, imported.documentId, "original.pdf"), Buffer.from("changed"));
      await expect(restarted.originalResource(imported.documentId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15000);

  it("keeps the Linux converter workspace read-only and isolates its filesystem and network", async () => {
    const work = await mkdtemp(join(tmpdir(), "ipe-pdf-isolation-"));
    try {
      const script = [
        "test -r probe.txt", "! test -e /home", "! test -e /mnt/c", "! test -w /work",
        "readlink /proc/self/ns/net",
      ].join(" && ");
      await writeFile(join(work, "probe.txt"), "staged");
      const { stdout } = await runControlledProcess("/usr/bin/sh", ["-c", script], work,
        NATIVE_PROCESS_LIMITS, "NATIVE_LOAD_ERROR", {}, "pdf-import");
      expect(stdout.trim()).toMatch(/^net:\[\d+\]$/u);
      expect(stdout.trim()).not.toEqual(await readlink("/proc/self/ns/net"));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("retains same-sized pages and rejects mixed sizes in Ipe's document-wide layout", async () => {
    const contents = ".2 g 10 10 30 40 re f";
    const result = await importPdf(pdfFixture(contents, { secondPage: { width: 160, height: 96 } }));
    expect(result.document.pages.map((page) => page.objects.length)).toEqual([1, 1]);
    expect(new Set(result.document.pages.map((page) => page.id)).size).toBe(2);
    await expect(importPdf(pdfFixture(contents, { secondPage: { width: 120, height: 96 } }))).rejects.toMatchObject({
      diagnostic: { code: "PDF_MIXED_PAGE_SIZES_UNSUPPORTED", location: "pdf.page[1]" },
    });
  });

  it.each([
    [pdfFixture("0 0 4 4 re f BX secret-canary EX"), "PDF_OPERATOR_UNSUPPORTED"],
    [pdfFixture("0 0 4 4 re f BT (secret-canary) Tj ET"), "PDF_TEXT_UNSUPPORTED"],
    [pdfFixture("BT /F1 22 Tf 30 30 Td (Ipe) Tj ET", { resources: "<< /Font << /F1 << /Subtype /Type1 /BaseFont /UntrustedFont >> >> >>" }), "PDF_FONT_UNSUPPORTED"],
    [pdfFixture("BI /W 1 /H 1 ID a EI"), "PDF_INLINE_IMAGE_UNSUPPORTED"],
    [pdfFixture("0 0 4 4 re W* n"), "PDF_EVEN_ODD_CLIP_UNSUPPORTED"],
    [pdfFixture("0 0 4 4 re f", { catalog: "/OpenAction << /S /URI /URI (file:///private/secret-canary) >>" }), "PDF_CATALOG_FEATURE_UNSUPPORTED"],
    [pdfFixture("0 0 4 4 re f", { stream: "/F (file:///private/secret-canary)" }), "PDF_STREAM_FEATURE_UNSUPPORTED"],
    [pdfFixture("0 0 4 4 re f", { page: "/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 4 4] >>]" }), "PDF_ANNOTATIONS_UNSUPPORTED"],
    [pdfFixture("0 0 4 4 re f " + "%a".repeat(270_000), { compressed: true }), "PDF_CONTENT_BYTE_LIMIT"],
  ])("rejects unsupported, active or oversized PDF input with a stable location", async (source, code) => {
    await expect(importPdf(source)).rejects.toThrow(expect.objectContaining({
      diagnostic: { code, location: expect.stringMatching(/^pdf(?:\.page\[\d+\](?:\.operator\[\d+\])?)?$/u) },
    }));
  });
});
