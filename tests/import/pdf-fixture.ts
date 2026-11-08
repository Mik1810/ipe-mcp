import { deflateSync } from "node:zlib";

/** Deterministic, MIT-licensed fixture builder. No native tool is needed to construct inputs. */
export function pdfFixture(contents: string, options: { catalog?: string; page?: string; stream?: string; resources?: string; extra?: Buffer[]; compressed?: boolean; secondPage?: { width: number; height: number } } = {}): Buffer {
  const source = Buffer.from(contents, "ascii");
  const stream = options.compressed ? deflateSync(source) : source;
  const secondPageId = options.secondPage ? 5 + (options.extra?.length ?? 0) : undefined;
  const pages = secondPageId === undefined ? "3 0 R" : "3 0 R " + secondPageId + " 0 R";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R " + (options.catalog ?? "") + " >>"),
    Buffer.from("<< /Type /Pages /Count " + (secondPageId === undefined ? 1 : 2) + " /Kids [" + pages + "] >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 96] /Contents 4 0 R "
      + (options.resources ? "/Resources " + options.resources + " " : "") + (options.page ?? "") + " >>"),
    Buffer.concat([Buffer.from("<< /Length " + stream.length + (options.compressed ? " /Filter /FlateDecode " : " ")
      + (options.stream ?? "") + " >>\nstream\n"), stream, Buffer.from("\nendstream")]),
    ...(options.extra ?? []),
    ...(options.secondPage ? [Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
      + options.secondPage.width + " " + options.secondPage.height + "] /Contents 4 0 R >>")] : []),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    const block = Buffer.concat([Buffer.from((index + 1) + " 0 obj\n"), object, Buffer.from("\nendobj\n")]);
    offsets.push(size);
    parts.push(block);
    size += block.length;
  }
  parts.push(Buffer.from("xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n"
    + offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("")
    + "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + size + "\n%%EOF\n"));
  return Buffer.concat(parts);
}

export const PDF_VECTOR_CONTENT = [
  ".156 .349 .686 rg 10 15 70 62 re f",
  "q 36 20 55 60 re 64 27 20 50 re W n",
  ".796 .2 .164 rg 50 30 m 50 72 90 78 106 45 c 106 25 64 8 50 30 c h f",
  "Q",
  "q 1 0 0 1 6 3 cm 0 G 4 w 1 J 1 j 92 32 m 101 57 113 60 124 33 c S Q",
  ".972 .741 .25 rg 113 56 20 24 re f",
].join("\n");

export function pdfMixedFixture(): Buffer {
  const rgb = Buffer.alloc(40 * 40 * 3);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      rgb.set([x < 20 ? 255 : 0, y < 20 ? 255 : 0, x >= 20 && y >= 20 ? 255 : 0], (y * 40 + x) * 3);
    }
  }
  const image = deflateSync(rgb);
  const imageObject = Buffer.concat([Buffer.from("<< /Type /XObject /Subtype /Image /Width 40 /Height 40 /BitsPerComponent 8"
    + " /ColorSpace /DeviceRGB /Filter /FlateDecode /Length " + image.length + " >>\nstream\n"), image, Buffer.from("\nendstream")]);
  return pdfFixture("q 40 0 0 40 8 40 cm /Im1 Do Q\n1 g 26 58 4 4 re f\n.1 .4 .7 rg BT /F1 22 Tf 60 48 Td (Ipe MCP) Tj ET", {
    resources: "<< /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >>",
    extra: [Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"), imageObject],
  });
}
