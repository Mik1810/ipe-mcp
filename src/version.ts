import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMetadata = {
  readonly name: string;
  readonly root: string;
  readonly version: string;
};

function loadPackageMetadata(): PackageMetadata {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<PackageMetadata>;
      if (parsed.name === "ipe-mcp" && typeof parsed.version === "string" && parsed.version.length > 0) {
        return { name: parsed.name, root: directory, version: parsed.version };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  throw new Error("ipe-mcp package metadata is unavailable");
}

const metadata = loadPackageMetadata();

export const PRODUCT_NAME = metadata.name;
export const PRODUCT_VERSION = metadata.version;
export const PACKAGE_ROOT = metadata.root;
