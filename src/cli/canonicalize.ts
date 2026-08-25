import { writeFile } from "node:fs/promises";

import { canonicalizeIpe } from "../core/ipe-document-codec.js";
import { readFileBounded } from "../persistence/bounded-read.js";

const [, , inputPath, outputPath] = process.argv;
if (inputPath === undefined || outputPath === undefined) {
  throw new Error("usage: canonicalize INPUT.ipe OUTPUT.ipe");
}

const source = await readFileBounded(inputPath, 16 * 1024 * 1024);
await writeFile(outputPath, canonicalizeIpe(source), { encoding: "utf8", mode: 0o600 });
