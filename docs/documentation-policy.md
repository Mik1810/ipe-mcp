# Documentation Naming and Lifecycle Policy

## Authority

When documents overlap, use this order: the current code and executable gates;
accepted ADRs and explicit contracts; living guides/reference; milestone and
release evidence; dated audits and research dossiers. `README.md` and
`docs/README.md` are navigation and status summaries, not substitutes for the
underlying contract.

## Names and locations

- Living public guides use stable lowercase kebab-case names in `docs/guides/`
  without milestone prefixes, for example `agent-manual.md`.
- Release records live in `docs/releases/`; a stable filename may retain its
  milestone/version provenance in the heading and introduction.
- Evidence-only reviews live in `docs/audits/`; dated snapshots include an ISO
  date, while a single durable audit may use a stable descriptive name.
- Accepted architecture decisions use `docs/adr/NNNN-description.md` and are
  immutable except for corrections or explicit supersession metadata.
- Normative matrices and machine-readable reference data live in
  `docs/reference/`. Generated files use stable descriptive names and state
  their generator and verification path.
- Milestone delivery/evidence records live in `docs/milestones/` and retain
  milestone provenance. They are frozen after acceptance except for link fixes,
  factual corrections, or an explicit addendum.
- Repository process instructions live in `AGENTS.md` and `.agents/`; setup
  instructions may remain at the root when they are a primary entry point.

## Lifecycle labels

- **Maintained:** living guidance updated with relevant behavior or support
  changes.
- **Milestone-frozen:** accepted delivery or release evidence; do not silently
  rewrite historical claims.
- **Generated:** reproducible artifact whose generator is authoritative.
- **Evidence-only:** audit or retained host/test evidence, not product guidance.
- **Superseded:** retained only when history still has value and linked to its
  replacement.
- **Deferred review:** known candidate for a later bounded decision; it is not
  authoritative while deferred.

Every new document must state or make discoverable its objective, audience,
authoritative scope, lifecycle, and main inbound consumer. Renames must update
links, generators, and gate consumers atomically. Do not create a second living
manual for a different audience; improve the single manual instead.
