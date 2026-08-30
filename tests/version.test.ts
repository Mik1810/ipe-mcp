import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, PRODUCT_VERSION } from "../src/version.js";

describe("product metadata", () => {
  it("derives the public server identity from package.json", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
    };
    expect(PRODUCT_NAME).toBe(packageJson.name);
    expect(PRODUCT_VERSION).toBe(packageJson.version);
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  });
});
