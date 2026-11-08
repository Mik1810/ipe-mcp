# ADR-0009 — Keep presentations on discrete Ipe views

- Status: **Accepted scope decision. Manim experiment archived.**
- Spike: [#43](https://github.com/Mik1810/ipe-mcp/issues/43)
- Out-of-scope proposals: [web presenter #42](https://github.com/Mik1810/ipe-mcp/issues/42) and [continuous video #44](https://github.com/Mik1810/ipe-mcp/issues/44)

## User value and decision

A speaker can export a transition as a clip for a recorded lecture or a
player that cannot interpolate Ipe views. The representative case moves
one shape linearly between two Ipe views while holding a reference
shape and a mathematical label still. The reference is native Ipe
rendering at both endpoints. Between endpoints the oracle is the
analytic center of the moving polygon.

The product uses discrete Ipe views and PDF pages. The dedicated web
presenter and continuous video are outside its scope. The Manim spike
verified a small linear motion subset and reproducible encoding. The
label changed size in the rendered clip, and the prototype excluded
common Ipe clipping, gradient, affine and transition semantics.
Supporting video would also require a separate Python and codec toolchain.

## Evidence

The [MIT fixture](https://github.com/Mik1810/ipe-mcp/blob/e371efff1a8a385e7222043b803b2dd8b2d3a3b5/fixtures/conformance/m10/manim/translation.ipe)
is authored in this repository. The [comparison sheet](https://github.com/Mik1810/ipe-mcp/blob/e371efff1a8a385e7222043b803b2dd8b2d3a3b5/fixtures/conformance/m10/manim/side-by-side.png)
shows the exact two native endpoint frames, the corresponding decoded
Manim frames, and Manim's generated midpoint. The [measurements](https://github.com/Mik1810/ipe-mcp/blob/e371efff1a8a385e7222043b803b2dd8b2d3a3b5/fixtures/conformance/m10/manim/evidence.json)
contain the per-frame boxes, colors, media properties, and sampled
render costs. No upstream deck or video is retained.

| Check | Observation on the measured lane |
| --- | --- |
| Geometry | Both endpoint bounding boxes agree to 0 px on the two polygons. The midpoint center is 0 px from the analytic target. |
| Color | Largest median fill-channel difference is 3 of 255 after H.264 encoding, within the gate tolerance of 8. |
| LaTeX and font | The same bounded formula compiles in both engines. At the dark-ink threshold the native formula is 48 × 16 px and Manim is 52 × 16 px. The PDF font inventory and availability of DejaVu Sans through Pango are recorded separately. Pango availability does not establish equivalent layout. |
| Timing and encoding | Linear motion takes 1.0 s, with two 0.1 s holds. The clip has 24 frames at 20 fps, 320 × 180 px, H.264 and no audio. Two renders in separate media directories produce identical MP4 bytes. |
| Render cost | The evidence retains milliseconds for native compilation plus two frames and two fresh Manim renders. These are samples, not latency guarantees or a like-for-like throughput benchmark. |
| Unsupported constructs | Separate input variants return UNSUPPORTED_CLIP, UNSUPPORTED_GRADIENT, UNSUPPORTED_AFFINE_TRANSFORM and UNSUPPORTED_VIEW_SEQUENCE. The probe treats images, arbitrary fonts, rich text, multi-page tracks, visibility changes and other untested objects as outside its measured subset. |

The scene compiler only admits the fixture's exact paper dimensions,
two views with identical visible layers, RGB-filled straight polygons,
one translated object, and a restricted mathematical label. It reports
the label geometry approximation. Native Ipe has no intermediate frame
for the motion, so the midpoint check does not establish continuous
Ipe rendering fidelity.

## Distribution, license and resource boundary

Manim Community 0.22.1 and ManimPango 0.7.1 report MIT. Pycairo 1.29.2
reports LGPL-2.1-only OR MPL-1.1. PyAV 19.0.2 reports BSD-3-Clause for
its bindings. The tested PyAV wheel also contains FFmpeg libraries and
libx264/libx265, so the binding license alone is insufficient for a
redistribution decision. The separate Ubuntu ffmpeg executable reports
GPL-enabled and libx264 support. Treat the wheel's bundled components
and the system executable as distinct SBOM entries if adoption is
reconsidered. Review exact wheel hashes, vendor configuration, bundled
codec and font licenses, source and notice obligations, and the
distribution model before packaging. The test leaves Python, native
dependencies, codecs and fonts outside npm.

The measured environment has 33 pinned Python distributions, a 412 MiB
virtual environment on disk, and 46 extra Ubuntu development packages
downloaded as 20 MiB of temporary archives. Development headers were
extracted without installing them on the system. The native lane uses
Ipe 7.2.30-1build2, Cairo 1.18.4, Pango 1.57.0, TeX Live 2025,
dvisvgm 3.6, the Ubuntu ffmpeg 8.0.1 package and bubblewrap
0.11.1-1ubuntu0.3. Python is CPython 3.13.14.

The gate runs a trusted fixture in a private temporary directory under
bubblewrap with user, PID and network namespaces. It uses a 45 s per
command deadline, 2 GiB address-space cap, 256 process cap and 64 MiB
file cap. LaTeX shell escape is disabled. The system is mounted
read-only with the private output directory writable. A future
production worker must also restrict what it can read, reject active
or external content before conversion, bound total frames and bytes,
propagate cancellation and keep video behind controlled resource
retrieval. The spike creates no MCP tool and changes no product
capabilities. Rolling it back requires removing the temporary Python
environment and its downloaded development dependencies.

## Archived experiment

The scripts, gate, dependency pins, and corpus were removed from the
active tree. The [original experiment and reproduction instructions](https://github.com/Mik1810/ipe-mcp/blob/e371efff1a8a385e7222043b803b2dd8b2d3a3b5/docs/adr/0009-manim-continuous-video-spike.md#reproduce)
remain available at the commit that integrated the spike.

## References

- [Manim 0.22.1 community license](https://github.com/ManimCommunity/manim/blob/v0.22.1/LICENSE.community)
- [Manim Community documentation](https://docs.manim.community/en/stable/)
- [Pycairo licensing and Cairo dependency](https://pycairo.readthedocs.io/en/latest/index.html)
- [PyAV installation and bundled FFmpeg](https://pyav.basswood.io/docs/stable/overview/installation.html)
- [FFmpeg project license](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)
- [Thin npm distribution](0005-distribution-versioning-and-native-dependencies.md)
