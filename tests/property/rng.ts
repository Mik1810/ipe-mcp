import type { Matrix } from "../../src/domain/ir.js";
import type { Box, Point } from "../../src/layout/geometry.js";

/**
 * Deterministic property/fuzz testing support.
 *
 * A single XorShift32 state per suite instance, a fixed SUITE_SEED exported by
 * each suite, and a bounded iteration count keep every run reproducible: a
 * failing case reports the exact seed, suite and case index, and re-running
 * with the same seed reproduces it.
 *
 * Generators only produce values inside the domain contract; suites remain
 * fully synchronous and allocate bounded input sizes only.
 */

export class XorShift32 {
  constructor(private state: number) {}
  next(): number {
    let value = this.state | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value | 0;
    return (value >>> 0) / 0x1_0000_0000;
  }
  between(minimum: number, maximum: number): number {
    return minimum + this.next() * (maximum - minimum);
  }
  integer(minimum: number, maximum: number): number {
    return Math.floor(this.between(minimum, maximum + 1));
  }
  pick<Item>(items: readonly Item[]): Item {
    return items[this.integer(0, items.length - 1)]!;
  }
  string(minimum: number, maximum: number, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"): string {
    const length = this.integer(minimum, maximum);
    let out = "";
    for (let index = 0; index < length; index += 1) out += alphabet[this.integer(0, alphabet.length - 1)];
    return out;
  }
  /** Well-conditioned affine: rotation, positive scales, bounded translation. */
  linearAffine6(angleDegrees: number, scaleX: number, scaleY: number, tx: number, ty: number): Matrix {
    const radians = (angleDegrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, tx, ty];
  }
}

export const DEFAULT_ITERATIONS = 1_024;

/** Bounded, environment-overridable iteration count (keeps gates deterministic and fast). */
export function iterations(): number {
  const value = Number(process.env.PROPERTY_ITERATIONS ?? DEFAULT_ITERATIONS);
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_ITERATIONS;
}

/** Well-conditioned random affine matrix: positive scales, no reflection at zero, bounded translation. */
export function randomMatrix(random: XorShift32): Matrix {
  return random.linearAffine6(
    random.between(-180, 180),
    random.between(0.2, 5),
    random.between(0.2, 5),
    random.between(-1_000, 1_000),
    random.between(-1_000, 1_000),
  );
}

export function randomPoint(random: XorShift32, magnitude = 1_000): Point {
  return { x: random.between(-magnitude, magnitude), y: random.between(-magnitude, magnitude) };
}

export function randomBox(random: XorShift32, magnitude = 1_000): Box {
  return {
    x: random.between(-magnitude, magnitude),
    y: random.between(-magnitude, magnitude),
    width: random.between(0.01, magnitude),
    height: random.between(0.01, magnitude),
  };
}

export const PINNED_SEEDS = {
  matrices: 0x1a2b3c4d,
  geometry: 0x5e6f7a8b,
  parser: 0x9c0d1e2f,
  crud: 0x3f4a5b6c,
  protocol: 0x7d8e9f0a,
} as const;

export function fail(seed: number, caseIndex: number, message: string): never {
  throw new Error(`[property] seed=${seed.toString(16)} case=${caseIndex}: ${message}`);
}
