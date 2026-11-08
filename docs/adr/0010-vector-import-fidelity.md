# ADR-0010 — Editable vector imports

- Status: **Proposed**
- Scope: SVG checkpoint for [#41](https://github.com/Mik1810/ipe-mcp/issues/41)

Import a bounded, declared source profile into editable Ipe objects. Reject the transaction at the first unsupported construct with a diagnostic code and ordinal source location. Successful imports create a private working document at revision zero. A separate resource returns the exact source bytes and their SHA-256 while the server is running.

| Source construct | SVG checkpoint |
| --- | --- |
| Geometry | Lines, polylines, polygons, circles, ellipses, rectangles and circular rounded corners. SVG path commands map to segments, cubics and Ipe elliptical arcs. Quadratic curves are represented as equivalent cubics. |
| Coordinates and ordering | Explicit root size, optional viewBox, meet or none aspect ratio, group and object affine transforms, and original paint order. Six significant digits for geometry and thousandths for RGB match the tested Ipe 7.2 XML precision. Strokes require uniform scale with orthogonal axes. |
| Styles | Solid fill and stroke, width, caps, joins and fill rule through presentation attributes and a limited inline style grammar. Clipping, masks, filters, gradients, external stylesheets, CSS selectors and non-unit opacity cause rejection. |
| Text and fonts | Rejected explicitly. No LaTeX or font substitution is generated. |
| Images | Canonical inline base64 PNG with bounded, noninterlaced decode of samples up to 8 bits and a chunk allowlist. Native bitmap pixels, placement and paint order are retained. External and linked images and other encodings are rejected. |
| PDF | Pending. A PDF drawing trace can establish what was painted, while the page operator and document structure preflight must establish what could be dropped. Require both before claiming support. |

## Threat model delta

This proposal extends [ADR-0004](0004-security-and-trust-boundaries.md).

- **TM-XML** — Parse SVG as UTF-8 with DTD, processing instructions, foreign namespaces, active elements and event attributes rejected. A 1 MiB source cap applies before parsing. Element count, depth, attribute count and numeric ranges are bounded. Only validated, generated values enter Ipe XML.
- **TM-ASSET** — Never resolve source paths, URLs or references. Verify PNG signature, chunk framing, CRC and pixel limits. Limit cumulative decode to one million pixels. Reject interlaced streams before the decoder because that branch of the decoder has no inflated-output cap.
- **TM-FS / TM-CONCURRENCY** — Store the imported document in a new private working session and keep the source in the existing bounded artifact store. Discard the artifact if session creation fails. Destination saves use the existing confirmed write flow.
- **TM-METADATA / TM-HTTP** — Return diagnostic code and ordinal location. Do not include input bytes or URL values in errors. Retrieve originals on demand through the existing authenticated or local artifact transport. Source resources are scoped to the server lifetime. Durable provenance is pending.
- **TM-PROC** — SVG conversion starts no external process. PDF needs a separately reviewed converter boundary with fixed commands, resource and subprocess limits, private staging and a deny-by-default source profile.

## Measured evidence

The MIT-licensed vector fixture compares the Ipe PNG with the MuPDF rendering at 160 × 96. The test allows at most 32 pixels with an RGB channel difference above 32. A separate synthetic 40 × 40 PNG asserts all four quadrant colors and the color of a vector shape painted above the image. Both fixtures pass native validation. The vector fixture additionally exercises explicit save, reload with stable object IDs, and PDF export.

A 2 × 2 bitmap enlarged to 40 × 40 exposed a difference between the two native PDF rendering paths used by the existing validation gate. The current native validation can also reject lossless bitmap recompression because its round-trip check compares the compressed representation. These cases remain open even when the preview renders. The gate and its thresholds are unchanged. Image fidelity claims are limited to the measured cases.

Run the scoped gate with \`bash scripts/gates/check-m10-vector-import.sh\` in the verified native Linux lane. The complete issue remains open pending PDF support, text and font oracles, and a decision on durable source provenance.
