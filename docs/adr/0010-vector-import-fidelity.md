# ADR-0010 — Editable vector imports

- Status: **Accepted**
- Scope: [#41](https://github.com/Mik1810/ipe-mcp/issues/41)

Import a declared source profile into a new private Ipe session at revision zero. Reject the transaction at the first unsupported construct with a diagnostic code and source location. Keep the original bytes, SHA-256 and import diagnostics with the session. The original resource remains available after explicit session recovery. The canonical Ipe source and the original source are separate resources.

| Construct | SVG profile | PDF profile |
| --- | --- | --- |
| Geometry and order | Lines, polylines, polygons, rectangles with optional circular corners, circles, ellipses and SVG path commands. Quadratics become equivalent cubics. Source paint order is preserved. | Moves, lines, rectangles and cubic path operators. Opaque fill and stroke paint in trace order, including combined operators. |
| Coordinates | Explicit viewport and supported physical units, optional viewBox, meet or none aspect ratio, and group or object transforms. | Page bounds from MuPDF, orthogonal page rotation, bounded user units and page sizes shared across the document. |
| Styles | Solid fill and stroke, width, caps, joins, winding rule and limited inline styles. | Opaque DeviceGray and DeviceRGB, solid strokes with native caps and joins, and nonzero or even-odd fill. |
| Clipping and effects | Clip paths, filters, masks, gradients, pattern paints and group opacity cause rejection. | Nonzero path clips become Ipe groups. An implicit rectangular crop from the engine is also represented. Explicit even-odd clipping, shadings, arbitrary graphics states, forms and layers cause rejection. |
| Text and fonts | Text causes rejection with an explicit diagnostic. | Horizontal, fill-only PDF text from supported literal operators and the Latin standard Type1 families Times, Helvetica and Courier becomes editable glyph outlines. Verify the engine's Unicode mapping before converting. The receipt signals that searchable or editable text is absent from the converted document. Keep the logical source in the original PDF. Custom fonts, unsupported encodings, clipping text and unsupported text operators cause rejection. |
| Images | Embedded noninterlaced PNG with samples up to 8 bits and a chunk allowlist. | Embedded 8-bit RGB or gray image XObjects with no mask or custom color transform and with raw or Flate content. Native bitmap placement and pixels are retained. The receipt flags renderer-dependent image interpolation. |
| Unsupported styles and references | External references, stylesheets, active content, dashes and strokes under nonuniform scale or shear cause rejection. | External streams, scripts and actions, annotations, encrypted or repaired input, dashes, hairline strokes, nondefault miter limits and nonuniform or sheared strokes cause rejection. |

SVG input is limited to 1 MiB. PDF input is limited to 2 MiB. The PDF profile supports up to 24 pages, 512 KiB of decoded page content, 8,000 operators, 2,000 drawing events, 12,000 path commands, 4,000 glyphs and 100,000 decoded image pixels across the document. The converter requires the isolated Linux runtime and was exercised with MuPDF 1.27.0. Geometry is canonicalized to Ipe's tested XML precision. PDF metadata from the allowed information dictionary is retained in the original with a receipt diagnostic.

## Threat model delta

This decision extends [ADR-0004](0004-security-and-trust-boundaries.md).

- **TM-XML** — Parse SVG as UTF-8 with DTDs, processing instructions, foreign namespaces, active elements and event attributes rejected. Bound depth, attributes, tokens and numeric ranges. Treat generated glyph SVG as untrusted output and accept only locally referenced outline paths with numeric transforms. Only validated generated values enter Ipe XML.
- **TM-ASSET** — Resolve neither source paths nor URLs. Verify PNG framing, chunk types, CRC and pixel limits. Reject interlaced SVG images before decoding. Preflight PDF image dictionaries and cumulative pixels before extracting accepted image samples.
- **TM-PROC** — SVG starts no child process. PDF uses a fixed MuPDF executable and packaged worker in a networkless Linux namespace with a read-only staging mount and only the system runtime mounted. Apply deadline, output, address space and process limits. Independently check source operators and the rendering trace, reject repair and warnings, and validate the worker receipt before conversion.
- **TM-FS / TM-CONCURRENCY** — Store source bytes in the private session directory before committing the manifest. Resolve the session directory, refuse symlinks at the original file, and verify the receipt hash before returning bytes. Saving to a user-selected destination uses the existing confirmed write flow.
- **TM-METADATA / TM-HTTP** — Report stable diagnostic codes and ordinal locations. Worker failures and resource integrity errors expose no source strings, native stderr or paths. Deliver original bytes on demand through the existing session resource and transport boundary.

## Measured evidence

Run `bash scripts/gates/check-m10-vector-import.sh` in the verified native Linux lane. The deterministic corpus is covered by the repository MIT license. It includes SVG vector and embedded PNG fixtures, generated PDF geometry, the mixed PDF with text and an image, and hostile inputs for both formats.

| Fixture | Oracle |
| --- | --- |
| SVG vector, 160 × 96 | Ipe and MuPDF differ by more than 32 in a color channel at no more than 32 pixels. The test checks frontmost color and the interior of a closed arc. |
| SVG embedded PNG | Four quadrant colors, foreground overlay and native validation. |
| PDF vector, 160 × 96 | Ipe and MuPDF differ by more than 32 in a color channel at no more than 96 pixels. The test checks compound nonzero clipping, path order, structural and native validation, stable IDs on reopen and PDF export. |
| PDF mixed, 160 × 96 | Four exact image colors and an exact foreground overlay. In the text region, no more than 110 pixels differ in the ink mask. Full native validation, save, reopen, PDF export, original SHA-256 and diagnostics after recovery all pass. |
| Portable PDF scenario | Official SDK stdio adapter checks the exact original bytes, initial revision, diagnostics, validated Ipe outline, reopening and PNG/PDF artifacts. |

Image rendering under scaling depends on the renderer's resampling. A 2 × 2 bitmap enlarged to 40 × 40 exposed a discrepancy between Ipe's two native PDF rendering paths. The PDF comparison gate still flags that discrepancy. Lossless Flate recompression is verified by the existing decoded-pixel hash while retaining the bitmap's other rendering attributes.
