import { describe, expect, it } from "vitest";

import { compareHeadingAnchors, parsePdfLines } from "../../scripts/harness/slide-style.mjs";

const title = "A & B";
const line = (x, y = 50) => ({ text: title, x, y });
const states = [1, 2, 3].map((view) => ({ slide: 1, view }));
const rasters = new Set(["s1-v1", "s1-v2", "s1-v3"]);
const headings = [{ slide: 1, text: " A  & B ", intentionalMoves: [] }];

describe("persistent heading anchor", () => {
  it("reads word content, coordinates and physical page order", () => {
    const xml = '<html><body><doc><page><line xMin="14.5" yMin="32">' +
      '<word>A</word><word>&amp;</word><word>B</word></line></page><page/></doc></body></html>';
    expect(parsePdfLines(xml)).toEqual([[line(14.5, 32)], []]);
  });

  it("compares adjacent views with a one-point tolerance and locates drift", () => {
    const result = compareHeadingAnchors(states, [[line(10)], [line(11)], [line(11, 54)]], headings, rasters);
    expect(result).toEqual({
      compared: 2,
      intentionalMoves: 0,
      findings: [{
        criterion: "HEADING_ANCHOR_SHIFT", slide: 1, view: 3, pdfPage: 3, evidence: "s1-v3.png",
        previousView: 2, previousPdfPage: 2, previousEvidence: "s1-v2.png",
        measurement: { dx: 0, dy: 4, unit: "bp", tolerance: 1 },
      }],
    });
  });

  it("exempts only the specified transition", () => {
    const allowed = [{ ...headings[0], intentionalMoves: [{ view: 2, reason: "Deliberate move" }] }];
    const result = compareHeadingAnchors(states, [[line(10)], [line(30)], [line(40)]], allowed, rasters);
    expect(result.intentionalMoves).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ criterion: "HEADING_ANCHOR_SHIFT", view: 3 });
  });

  it.each([[[]], [[line(30), line(80)]]])("reports an unobservable anchor without bridging the gap (%j)", (matches) => {
    const result = compareHeadingAnchors(states, [[line(10)], matches, [line(40)]], headings, rasters);
    expect(result.compared).toBe(0);
    expect(result.findings).toEqual([{
      criterion: "HEADING_ANCHOR_UNOBSERVABLE", slide: 1, view: 2, pdfPage: 2, evidence: "s1-v2.png",
      measurement: { matchingLines: matches.length, expected: 1 },
    }]);
  });

  it("does not compare across slide boundaries with the same heading", () => {
    const secondSlide = { ...headings[0], slide: 2 };
    const next = [{ slide: 2, view: 1 }, { slide: 2, view: 2 }];
    const result = compareHeadingAnchors([...states.slice(0, 2), ...next],
      [[line(10)], [line(10)], [line(40)], [line(40)]], [...headings, secondSlide], rasters);
    expect(result).toEqual({ compared: 2, intentionalMoves: 0, findings: [] });
  });
});
