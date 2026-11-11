import { SaxesParser } from "saxes";

const toleranceBp = 1;
const normalize = (text) => text.replace(/\s+/gu, " ").trim();

export function parsePdfLines(xml) {
  const pages = [];
  const parser = new SaxesParser();
  let line, word;
  parser.on("opentag", ({ name, attributes }) => {
    if (name === "page") pages.push([]);
    if (name === "line") {
      line = { words: [], x: Number(attributes.xMin), y: Number(attributes.yMin) };
      if (!Number.isFinite(line.x) || !Number.isFinite(line.y)) throw new Error("Invalid PDF text bounds");
    }
    if (name === "word") word = "";
  });
  parser.on("text", (text) => {
    if (word !== undefined) word += text;
  });
  parser.on("closetag", ({ name }) => {
    if (name === "word") {
      line.words.push(word);
      word = undefined;
    }
    if (name === "line") {
      pages.at(-1).push({ text: normalize(line.words.join(" ")), x: line.x, y: line.y });
      line = undefined;
    }
  });
  parser.write(xml).close();
  return pages;
}

export function compareHeadingAnchors(states, pages, headings, rasters) {
  const configured = new Map(headings.map((heading) => [heading.slide, heading]));
  const findings = [];
  let compared = 0;
  let intentionalMoves = 0;
  let previous;
  for (const [index, { slide, view }] of states.entries()) {
    const heading = configured.get(slide);
    if (!heading) continue;

    const stem = "s" + slide + "-v" + view;
    const evidence = rasters.has(stem) ? stem + ".png" : null;
    const pdfPage = index + 1;
    const matches = pages[index].filter((line) => line.text === normalize(heading.text));
    const location = { slide, view, pdfPage, evidence };
    const current = matches.length === 1 ? { ...location, ...matches[0] } : undefined;
    if (!current) {
      findings.push({ criterion: "HEADING_ANCHOR_UNOBSERVABLE", ...location,
        measurement: { matchingLines: matches.length, expected: 1 } });
    } else if (previous?.slide === slide && previous.view === view - 1) {
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      compared++;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > toleranceBp) {
        if (heading.intentionalMoves.some((move) => move.view === view)) {
          intentionalMoves++;
        } else {
          findings.push({ criterion: "HEADING_ANCHOR_SHIFT", ...location,
            previousView: previous.view, previousPdfPage: previous.pdfPage,
            previousEvidence: previous.evidence,
            measurement: { dx, dy, unit: "bp", tolerance: toleranceBp } });
        }
      }
    }
    previous = current;
  }
  return { findings, compared, intentionalMoves };
}
