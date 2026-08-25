import { createHash } from "node:crypto";

/** Canonical in-memory object ID derived from its persisted Ipe custom value. */
export function objectIdFromCustom(custom: string): string {
  return `object-${createHash("sha256").update(custom).digest("hex").slice(0, 24)}`;
}

/** Ipe preserves `custom`, but may discard unknown identity attributes. */
export function persistentObjectCustom(id: string, custom: string): string {
  return objectIdFromCustom(custom) === id ? custom : `ipe-mcp:object-id:${id}|${custom}`;
}

export function parsePersistentObjectCustom(value: string): { readonly id: string; readonly custom: string } | undefined {
  const match = value.match(/^ipe-mcp:object-id:(object-[a-f0-9]{24})\|(.*)$/su);
  return match === null ? undefined : { id: match[1]!, custom: match[2]! };
}

export type PersistentEntityKind = "page" | "layer" | "view" | "style" | "asset" | "object";

export function isPersistentEntityId(kind: PersistentEntityKind, id: string): boolean {
  return new RegExp(`^${kind}-[a-f0-9]{24}$`, "u").test(id);
}

export function assertPersistentEntityId(kind: PersistentEntityKind, id: string): void {
  if (!isPersistentEntityId(kind, id)) throw new Error(`Invalid persistent ${kind} ID: ${id}`);
}
