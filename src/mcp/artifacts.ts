import { randomUUID } from "node:crypto";

export interface StoredArtifact {
  readonly id: string;
  readonly family: "artifact" | "preview";
  readonly data: Buffer;
  readonly mediaType: string;
  readonly name: string;
  readonly sha256: string;
  readonly metadata: Record<string, unknown>;
}

export class ArtifactStore {
  readonly #items = new Map<string, StoredArtifact>();
  #bytes = 0;
  constructor(readonly maxItemBytes = 16 * 1024 * 1024, readonly maxTotalBytes = 64 * 1024 * 1024) {}

  put(item: Omit<StoredArtifact, "id">): StoredArtifact {
    if (item.data.length > this.maxItemBytes) throw new Error(`artifact exceeds ${this.maxItemBytes} byte resource limit`);
    if (this.#bytes + item.data.length > this.maxTotalBytes) throw new Error(`artifact store exceeds ${this.maxTotalBytes} byte limit`);
    const stored = { ...item, id: randomUUID(), data: Buffer.from(item.data) };
    this.#items.set(stored.id, stored); this.#bytes += stored.data.length;
    return stored;
  }
  get(id: string): StoredArtifact | undefined { return this.#items.get(id); }
  uri(item: StoredArtifact): string { return `ipe://${item.family === "preview" ? "previews" : "artifacts"}/${item.id}`; }
}
