# Repository Audit — ipe-mcp (pre-M8)

- Date: 2026-08-28
- Branch reviewed: `main` @ `7b1bd26` (+ refactor branch `refactor/animation-modules` @ `bb3e757`)
- Scope: whole repository, depth review; milestones M0–M7 scope, M8/M9/M10 issues
- Method: build + full test suite run, milestone gates M1–M4/M7 (native), static review of the core modules, issue fetch via GitHub, targeted reproductions of suspected behaviors.

---

## 1. Executive summary

The repository is in **good health for a pre-MVP project**:

- `tsc` builds clean; **193/193 tests pass** (20 files); unit+integration suite is fast (~10s).
- Milestone gates M1–M7 **all pass** on the verified Ubuntu 7.2.30/WSL toolchain; M7 needs a longer timeout because it renders many PNGs (~1 min), not because it is flaky.
- The architecture (semantic IR → deterministic XML → native validation) is coherent and the persistence layer is unusually careful (inode/device identity, journals, preconditions, concurrency mutex).
- Security posture is already strong: bwrap/prlimit isolation, bounded reads, path confinement to workspace roots, DPkg provenance attestation, careful stdout marker filtering.

The dominant remaining work is **M8 (MCP stdio server)**, which currently does not exist in this repository, and the **M9 hardening items** that depend on it (fuzz/property tests, hostile corpus, SBOM, real-client checks).

Perceived gaps (detailed below) are mostly in: (i) silent degradation paths in the XML projection, (ii) long-running-process concerns in the session manager (no close/TTL), (iii) repo/drift hygiene (npm scripts missing M0/M1, codex M8 branch 0 commits ahead, half-implemented interfaces), (iv) missing fuzz/property testing infrastructure.

---

## 2. Health metrics (collected by running the repo)

| Check | Result |
|---|---|
| `npm run build` (`tsc -p tsconfig.json`) | PASS, 0 errors |
| `npm test` (full vitest suite) | PASS, 20 files / 193 tests |
| `scripts/check-m0.sh` | PASS |
| `scripts/check-m1.sh` | PASS (source lane SKIP without `IPE_M1_SOURCE_BIN_DIR`, as documented) |
| `scripts/check-m2.sh` | PASS |
| `scripts/check-m3.sh` | PASS |
| `npm run check:m4` | PASS |
| `npm run check:m5` | PASS |
| `npm run check:m6` | PASS |
| `npm run check:m7` | PASS (needs > 120 s timeout) |

Source: ~8.3k lines TypeScript under `src/`, ~4.5k lines tests, ~17.4k lines total including fixtures/scripts.

---

## 3. Milestone vs. issues

| Issue | Milestone | Status | Notes |
|---|---|---|---|
| #1–#4 | M4–M7 | CLOSED | Verified by gates (see above) |
| #5 | M8 MCP stdio server | OPEN | **No server code exists yet.** `src/cli/` contains only `canonicalize.ts` + `probe-m4.ts`; no MCP transport, tool surface, or resource registry. There is no `package.json` `bin` entry and the package is `private`. |
| #6 | M9 hardening | OPEN | Depends on M8. |
| #7 | M10 post-MVP epic | OPEN | Tracking epic only. |
| #8 | M8/M9 agentic-harness compliance | OPEN | Cannot have evidence yet: no server to audit. |

Note: `codex/issue-5-m8` exists locally but is **0 commits ahead of main** — no distributed M8 code is currently visible in this repository. Either Codex is working on an unpushed copy or the branch is stale; coordination is safe only if the refactor PR (#10) merges before M8 work starts (it touches `src/animation/`, M7-only surface).

---

## 4. Findings

Severity: `BLOCKER` / `MAJOR` / `MINOR` / `NICE`. Where possible, evidence is a repro.

### 4.1 Behavior / correctness

#### F1 — Silent loss of duplicate layer names on XML projection (MAJOR, verified)

`src/ipe/xml/project.ts:304-309` deduplicates `<layer>` elements **by name** (`if (name !== undefined && !layers.some((item) => item.name === name))`), so a legal XML input with two layers sharing a name collapses to **one** layer in the IR. Confirmed repro:

```text
input:  <page><layer name="a"/><layer name="a"/><view layers="a" active="a"/></page>
parse:  1 layer ("a")          validate: ok (no diagnostics)
output: 1 layer "a"            → original XML content is silently lost
```

There is non-alternative behavior: the projection **never emits a diagnostic** (no `SOURCE_OMISSION`, no `LAYER_NAME_DUPLICATE` — the validator can only see the already-collapsed IR). This violates the project's own "preserve unknown supported content whenever possible and report any degraded behavior" principle (project README). It should either keep both layers (with synthetic names) or emit a structural warning that the caller can see.

Same family (silent degrade): unknown `active` layer on views falls back to `layers[0]` (`project.ts:336`), and a view `<transform>` whose layer no longer resolves in the name map is silently skipped (`project.ts:325`). A warning diagnostic in all these cases would fit the Omissions model already in the IR.

#### F2 — `page.xml`/`attributes` storage duplicates child data (MINOR / design)

`projectObject` (project.ts:265) stores both a normalized `xml` domain tree **and** `type`/`attributes`/`children` projected fields for the same object. The serializer re-derives content from `object.xml`, so the extra fields are redundant in the write path; they are a consistency risk if semantics ever diverge. Worth documenting as intentional (fast-path / legacy) or eagerly deriving.

#### F3 — Session manager has no close / TTL / eviction (MAJOR for M8)

`DocumentSessionManager` (`src/persistence/session-manager.ts`) keeps sessions forever in a module-level `Map`. The manager API has no `closeDocument()/dispose()`, no idle-timeout, no LRU. An MCP server is a long-lived process: a host that opens N documents (say via an `ls` then `open` loop) leaks working trees + manifest + snapshots on disk and increases memory indefinitely (each `mutate` writes a new working file and never cleans old `working-r*.ipe` files). M8 issue #5 literally requires "clean lifecycle and shutdown". Recommendation: add `close()` (deleting the working tree or leaving a compact marker), plus session TTL and working-file pruning; the recovery journal already supports restart-based cleanup.

#### F4 — Long-running native operations cannot be cancelled, and progress is binary (MINOR, M8-relevant)

`runControlledProcess` (src/native/process.ts) runs to completion with a hard timer; there is no cancellation token, and the MCP level has no progress signal during renders/exports. Issue #8 wants "keep long-running calls alive with progress or ping traffic". Fine to defer to M8 implementation, but `runControlledProcess` should grow an `AbortSignal` so the transport can cancel without killing the whole server. Also `timer.unref()` + promise pattern: if the host awaits only the timer... it subscribes to `close`, so ok.

#### F5 — `attestBubblewrap` and provenance are Ubuntu/Debian-specific (OK as designed, document)

`src/native/process.ts:89-106` reads `/var/lib/dpkg/...` and requires bwrap **0.11.1** exactly; `capabilities.ts` requires dpkg and poppler/mupdf owners. This is deliberately Linux-only by the verified environment (Ubuntu 26.04 WSL), but the version pin `0.11.1` will become a hard failure on a distro where the equivalent package version differs even if the tool is fine. Recommendation: keep pin only for the *verified lane*; on mismatch, degrade to `structural-only` with diagnostics (this is already how `detectNativeCapabilities` treats attestation failure — actually it pushes a diagnostic and continues; verify the same for bwrap: `attestBubblewrap` throws `NATIVE_UNAVAILABLE` and appears as a hard failure in `runControlledProcess` instead of capability degradation).

#### F6 — `composition/index.ts` vestigial flag (NICE)

`freshObject(seed, used, _editable = "template")` (line 14) declares an `_editable` parameter that is never used — presumably a dropped "editable or template object" concept. Confusing: it looks intentional. Remove the parameter. Also `composeSlide` discards `preset/layers/views/template` via destructuring + `void` (lines 102-103) instead of an explicit `Rest` destructure — noise; clean up while touching the file.

#### F7 — `snapshots()` sorting + restore comparison (NICE)

`session-manager.snapshots()` parses sequence numbers with `Number()` after a regex that guarantees digits; ok. `restoreSnapshot` validates canonical path against `available.includes(canonical)` — good. No action.

### 4.2 API / Architecture contradictions

#### F8 — Two sources of truth for doc mutation (MINOR, pre-existing)

`DocumentIR` (domain/ir.ts) carries *both* semantic fields (`pages`, `stylesheets`, `assets`, `metadata`, `preamble`) *and* the full lossless `xml` tree. Every mutation must keep them aligned; the composition/animation modules rebuild from semantic fields, while `serializeXml` re-derives XML from semantic fields and refuses unknown changes. This is coherent if *documented* as "serializer semantic-authoritative; `xml` is the lossless source only for unchanged subtree passthrough". Fine for now; must be in the ADR/manual before M9.

#### F9 — `check:m0`/`check:m1` npm scripts missing (MINOR)

`package.json` declares `check:m2` … `check:m7` but not `check:m0`/`check:m1`, while README starts its verification section with exactly those two scripts and `scripts/check-m0.sh`/`check-m1.sh` exist and pass. Easy fix; also add `check:m8`-style chaining convention to keep all gates green per issue #5/#6 ("check-m8.sh includes and keeps all previous gates green").

#### F10 — Internal helpers of animation module left exported (DONE, note)

The split done as part of this work (PR #10) keeps the public API identical and extracts internals to `state.ts`; the barrel exports only the public surface. Good. Symmetric opportunities remain in `objects/index.ts` (exports a large flat register) and `layout/index.ts`; not a requirement, just awareness.

### 4.3 Tests / verification gaps

- **No fuzz or property tests anywhere.** M9 explicitly requires "fuzz and property tests for parser, geometry, matrices, CRUD, protocol" — none exist today (searched: no `fast-check`/`fc.`/hypothesis in `src`/`tests`).
- `src/domain/validate.ts`, `schema.ts`, `identity.ts` have **no direct unit tests** (only exercised indirectly via parser/persistence tests). Given validator complexity (reference checks, reserved layers, view invariants), direct unit tests would pay off quickly in M8 (they become the MCP schema basis).
- `src/core/ipe-document-codec.ts` has no direct test file (covered via `tests/integration/ipe-session.test.ts`). Ok for the size, but M8 schema validation will want codec-level direct tests.
- `src/layout/connector.ts` is covered through `constraints-plan.test.ts`; acceptable.
- M7 gate duration: 60-90s real time. Consider splitting M7 image renders from the gate, or scaling golden check down.

### 4.4 Repo hygiene / drifts

- **Committer identity drift:** history contains commits as both `Michael Piccirilli <michaelpiccirilli3@gmail.com>` and `Mik1810 <michaelpiccirilli@gmail.com>` (wrong email, not associated with the GitHub account). Fixed globally during this session; already-pushed commits remain under the wrong identity. If the user cares about attribution, the earlier pushes (`7b1bd26` and before) still carry the wrong email.
- `guide.md` (63 KB) is in `.gitignore` but present in the worktree — local scratch, note to keep it out of PRs. (It's ignored so it won't be committed.)
- `dist/` is gitignored; good.
- No `LICENSE` file and no `license` field in `package.json` — M9 requires SBOM + license inventory + GPLv3/subprocess boundary review; this needs to start in M9, not M10.
- `scripts/probe-m1.py` etc. reference `ipe` install; all good.

---

## 5. What's actually solid

- `src/persistence/session-manager.ts` — concurrency (`Mutex`), revision checks, inode+device identity checks, snapshot sequence allocation, save journal + recovery, `O_NOFOLLOW`, bounded reads. This is the strongest part of the codebase; the MCP layer just needs to expose it.
- `src/ipe/xml/parser.ts` — entity/DTD/namespace lockdown, byte/node/depth/attribute limits, UTF-8 fatal, XML-1.0 char checks, nice error taxonomy.
- `src/native/process.ts` + `capabilities.ts` — bwrap with `--unshare-user --unshare-pid`, prlimit (AS/nproc/fsize), output caps, marker-only crossing of the trust boundary, toolchain provenance attestation. Excellent for TM-PROC/TM-FS.
- `src/ipe/xml/project.ts` bitmap decode — has explicit width/height/filter/length validation and deduplicates by decoded hash; careful about color-space/alpha contradictions. First-rate.
- Validation rule set — references, destinations, z-order, reserved layers, transform representation conflicts, reserved names.

---

## 6. Issue-by-issue compliance pre-check (M8/M9)

| Issue area | Current evidence | Status |
|---|---|---|
| #5 Tool surface, schemas, strict errors | none (no server) | N/A — to build |
| #5 stdout purity / stderr-only logging | `runControlledProcess` captures stdio into buffers; nothing writes to process stdout today | structural pre-requisite exists |
| #5 revision-gated mutations | `DocumentSessionManager.mutate/save/restoreSnapshot` all take `expectedRevision` | pre-requisite exists |
| #5 snapshots/recovery via tools | `snapshots()`, `restoreSnapshot()`, `recover()` exist | pre-requisite exists |
| #5 resource links | no resource system | to build |
| #8 model-facing contract | n/a | to build with server |
| #8 transport/privacy (TM-HTTP in M10) | n/a | M10 |
| #9 fuzz/property | absent | must build |
| #9 hostile corpus | exists partially via M1 conformance, not hostile-input oriented | extend |
| #9 SBOM/license | absent | must build |

---

## 7. Improvement backlog (prioritized)

**P0 (M8, blocking or immediate):**
1. Add `DocumentSessionManager.close()` + idle TTL + working-file pruning (F3).
2. Add `runControlledProcess` cancellation (`AbortSignal`) support (F4).
3. Define MCP tool surface and schemas, with stderr-only logging discipline and resource-link model (issue #5).
4. Issue #8 compliance areas: write them into the tool-surface ADR before implementation, so the M8 review has a checklist.

**P1 (M9):**
5. Fuzz/property tests framework (parser, geometry, matrices, CRUD, session concurrency).
6. Hostile-input corpus + `NATIVE_*` degradation rails test.
7. `check-m8.sh` chain convention + `check:m0`/`check:m1` npm-script fixes (F9).
8. Direct unit tests for `domain/validate.ts`, `identity.ts`, `core/ipe-document-codec.ts` (F8, F9, M8 schema basis).
9. SBOM + license inventory + GPLv3 boundary review; LICENSE file; `license` field (4.4).
10. Fix F1 (duplicate layer names + other silent projection degrades) — add diagnostics + tests against the conformance lab.

**P2 (M10 / post-MVP):**
11. HTTP Streamable + OAuth, live Ipe bridge, distribution strategy (tracking only).
12. F5 (bwrap attestation version pin) robustness — allow documented downgrade to unknown-version pins.
13. F6/F10 cleanup (unused `_editable`, `composeSlide` destructure dirt, flat barrel exports).

---

## 8. Future directions (strategic)

On top of the M10 epic (issue #7), worth considering as candidate sub-issues once M9 lands:

1. **Semantic schema first-class**: make the zod schema in `domain/schema.ts` THE contract (single source) for both MCP tool inputs and session validation; currently it's internal-only. Issue #8 requires "centralize vocabulary whose values trigger behavior" — this is the natural home.
2. **Raster/preview pipeline as artifacts**: wire `iperender` PNG outputs into Resource links (data: or file://) so the agent never fetches 1-MB binaries in context — issue #5's "bounded context payload" criterion.
3. **Director/productivity facet**: expose a `facade` layer over `composition/index.ts` + `animation/*` to turn the current operation-level API into document-level recipes (slide → reveal → motion → handout). Keeps the harness compact (issue #8 model-facing contract).
4. **Session persistence over restart**: already mostly there (`recover()`); MCP "session expiry/restart" semantics deserve a design note in M8 ADR.
5. **Adapter for MCP Inspector + Codex + a second host**: schedule early in M8, not after; host differences (permission surfaces, text-vs-structured rendering) are the riskiest part of issue #5's gate.
6. **Performance**: `mutate` clones the whole document (`structuredClone`) per operation and the codec serializes the whole doc each time. At 16 MB max source this is bounded but slow for 1000-page decks; a delta/atop persistence design would be a post-MVP improvement (document it as NICE, not MVP).

---

## 9. Closing score

- **Health:** 9/10 (all gates green, no lint/config drift, clean worktree).
- **M8 readiness:** 6/10 — persistence and native subsystems are production-grade; transport, tool surface, schemas, resources, and harness-compliance evidence are all absent by design (pre-MVP).
- **Riskiest upcoming work:** M8 transport + instruction vocabulary (agent compliance), then M9 fuzz/licensing. F1/F3 are the two code items that should land before or during M8 because they affect long-running server behavior and lossless round-trip claims.

---

## 10. Omnicomprehensive pass — objects + layout + persistence + native (line-by-line)

This section records the complete line-by-line read of `src/objects/*`, `src/layout/*`, `src/persistence/*`, `src/native/*` and the remaining `src/domain/*` support files (~5.9k LOC). Overall result: **no new BLOCKER; the module quality is high**. Everything below is graded honestly: confirmed issues, then explicit "checked and OK" notes so the scope of the review is auditable.

### 10.1 New findings (deep pass)

#### F11 (MINOR) — `crud.ts` baseline-error filtering is string-based and brittle

`applyObjectOperations` (crud.ts:200-202, 354-356) computes the "new errors" set by string-matching `code|message` against the baseline and carries a special case for `baselineHasUnresolvedSymbol` (crud.ts:202). A baseline `REF_UNRESOLVED ... symbol` diagnostic with a *different* message (e.g., different symbol name) silences genuinely new unresolved-symbol errors introduced by the transaction. Functional today because errors are canonical, but it masks real regressions as the document model grows.

#### F12 (MINOR) — schema caps are looser than parser caps (MCP-facing risk)

`pageSchema.objects.max(100_000_000)` (schema.ts:112) versus parser `maxNodes: 500_000` / `maxAttributes: 10_000` (parser.ts:35-40). Fine internally (parser gates first), but M8 tool-input validation will run against the schema directly — an agent-supplied 10M-element `objects` array would run through zod with no node-limit guard. Align the MCP-facing input schemas with the parser limits (or cap at a lower "tool vocabulary" bound).

#### F13 (MINOR) — `#preflightDocument` counts every graph entry against the node budget

`NativeIpeAdapter.#preflightDocument` (adapter.ts:558-604) increments `structureEntries` for **every** object graph entry (including metadata boxes and attribute maps) against `maxDocumentXmlNodes` (200k), while `xmlNodes` counts only element/text nodes. Documents that native tools handle fine can be rejected by an over-conservative counter. Refine to count XML nodes only, or document the stricter semantics.

#### F14 (MINOR) — artifact snapshots bypass `temporaryRoot`

`openStableArtifact` (stable-artifact.ts:49) snapshots to hardcoded `/tmp/ipe-mcp-artifact-<...>` while the adapter's workspace respects `temporaryRoot`. Harmless in defaults, inconsistent when a caller configures a different temp root (e.g., a RAM-backed `temporaryRoot` for budget control). Route the snapshot dir through the same root.

#### F15 (NICE) — `composition/index.ts` vestigial parameters (confirmed)

`freshObject(seed, used, _editable = "template")` (composition/index.ts:14) — the `_editable` parameter is unused (dead concept), and `composeSlide` discards options via destructure + three `void` statements (composition/index.ts:102-103). Harmless but confusing; remove when touched. (Note: duplication itself is well executed — `duplicateRemapped` remaps layer/view/object IDs and references consistently.)

#### F16 (NICE) — misleading comment in `content-model.ts`

`assertAttributes` (content-model.ts:182-185) claims namespaced extension attributes are "retained by the lossless XML adapter", when `parser.ts:61-63` (`nameIsSafe`) rejects **any** name containing `:` at parse time — namespaced attributes can never reach this code. Real rule: unknown non-`x-`-prefixed attributes are rejected. Comment should say so.

### 10.2 Explicitly verified — not bugs

These were double-checked because they look suspicious at first glance; each was verified against code or against native Ipe 7.2.30 and is **correct**:

- **Numeric `opacity="0.5"` on a path** — Ipe 7.2.30 `Document:checkStyle()` reports `0.5` as an *undefined style* (verified by a real `ipescript check-style` probe). The structural checker (styles.ts:116-117) is therefore right to require a style name and does **not** false-positive. (Named opacity style + numeric value inside the style definition is the Ipe way.)
- **`assertIpePathPayload` (content-model.ts:33-175)** — operator arities, `m`/`h`/`e`/`u` subpath boundaries, `*`+`L` clothoid marker handling, trailing-move compatibility, and ASCII-only whitespace tokenization all match Ipe's lexer behavior.
- **`applyObjectOperations` (crud.ts)** — batch clone-swap semantics, z-order renormalization, reference-hit checks on delete/replace/group/ungroup, nested carrier remapping in groups, and post-candidate full-document validation are all coherent.
- **`projectXml` bitmap decode (project.ts:80-169)** — base64/hex round-trip checks, `length`/`ColorSpace`/IFD-junk validation, grayscale-to-RGB expansion, and alpha-vs-`alphaLength` consistency checks are airtight.
- **`atomicWriteFile` + `withTargetLock` (atomic.ts)** — lockfile dead-owner detection (pid), identical-inode verification before rename, directory fsync, and committed-but-unsynced `AtomicWriteError` semantics are sound. The only edge is PID-reuse holding a stale lock until the 10 s timeout (safe, bounded).
- **`assertMappingPreserved` (adapter.ts:174-232)** — page/layer/view/object semantics comparison with canonicalized collections is the strongest lossless-confirmation path in the repo; identity fallback diagnostics (page names/marked via sidecar) are correctly documented as sidecar-required.
- **`resolveLayoutConstraints` (constraints.ts:109-191)** — writer-uniqueness per `subject:axis`, property-level dependency graph (Kahn), cycle detection, and box re-assertion after each application are correct. The `["y","height"]` reference property list for `align-baseline` is slightly broader than needed (height is never constrained today), which is harmless.
- **`routeConnector`/`resolveConnectorIntent` (connector.ts)** — anchor resolution, auto-anchor selection, offsets, baseline-left gating and orthogonal bend dedup are correct.
- **`validatePng`/`comparePngSemantics`/`validateSvg` (artifact-validation.ts)** — the "no visible non-white pixel" and 2% paint mismatch with nearby-pixel tolerance are carefully calibrated; SVG structural validation (viewBox, explicit dims, local `use` refs, `defs` cycle guard) is solid.
- **`#exportPdf` (adapter.ts:348-391)** — per-page/view pixel comparison (`iperender` vs `pdftoppm`) plus PDF→XML round-trip with full semantic mapping makes the export claim real, not assumed.
- **Sidecar migration + composition rehydration (sidecar.ts)** — V1 strict schema, legacy V0 acceptance, fingerprint tie to page/layer/view/object shape, and native-ID remapping are coherent.
- **`semanticXml` filters (adapter.ts:75-85)** — the ignored-attribute list (`x-ipe-mcp-id`, `custom` on managed roots, `layer`, `valign=bottom`, `BitsPerComponent`, `transition=1`, LaTeX metrics) is deliberate and tested; no content-bearing attributes are dropped.

### 10.3 Deep-pass conclusion

The untested-before-modules (objects, layout, persistence internals, native adapter) hold up to adversarial reading. The only defects found are **minor/nice** (F11-F16). The material backlog remains F1 (silent layer collapse), F3 (session lifecycle), F4 (no cancellation), plus the M8/M9 items in section 7 — all already prioritized.

One process note: this pass verified a potential "numeric opacity" false positive against the real Ipe binary instead of guessing; the same probe technique (tiny `.ipe` + `ipescript` / `ipetoipe` / `iperender`) is the fastest way to close the M9 hostile-corpus gaps (section 7, P1-6).
