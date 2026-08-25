import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  convertPoint,
  layoutGrid,
  layoutRow,
  type CoordinateSpace,
  type GridLayoutOptions,
  type LinearLayoutOptions,
  type PageCoordinateSystem,
  type Placement,
  type Point,
} from "../../src/layout/index.js";

interface Fixture {
  name: string;
  coordinateSystem: PageCoordinateSystem;
  sentinels: Array<{ point: Point; space: CoordinateSpace; ipe: Point }>;
  layout: ({ kind: "row" } & Omit<LinearLayoutOptions, "direction">) | ({ kind: "grid" } & GridLayoutOptions);
  expected: Placement[];
}

async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(resolve("fixtures/conformance/m3", name), "utf8")) as Fixture;
}

describe("M3 coordinate/layout golden fixtures", () => {
  for (const name of ["standard-layout.json", "presentation-16x9-layout.json"]) {
    it(`matches ${name} exactly`, async () => {
      const data = await fixture(name);
      for (const sentinel of data.sentinels) {
        expect(convertPoint(sentinel.point, sentinel.space, { kind: "ipe" }, data.coordinateSystem)).toEqual(sentinel.ipe);
      }
      const { kind, ...options } = data.layout;
      const actual = kind === "row"
        ? layoutRow(options as Omit<LinearLayoutOptions, "direction">)
        : layoutGrid(options as GridLayoutOptions);
      expect(actual).toEqual(data.expected);
      expect(Math.max(...actual.map((item) => item.box.y))).toBeGreaterThan(Math.min(...actual.map((item) => item.box.y)));
    });
  }
});
