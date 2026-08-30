# Documentation Map

Start with the document that matches the task:

- Use the [agent operational manual](./guides/agent-manual.md) to create, edit,
  validate, save, export, and recover documents.
- Use [host integration](./guides/host-integration.md) to configure Codex, MCP
  Inspector, VS Code, or an independent SDK host.
- Use [package installation](./guides/package-installation.md) to build, audit,
  install, configure, and roll back the thin local npm candidate.
- Use the [support policy](./guides/support-policy.md) to distinguish supported,
  degraded, warning, and rejected modes.
- Use the [roadmap](../ROADMAP.md) for architecture, completed milestones, and
  M10 future scope.
- Use [ADRs](./adr/) for durable architectural decisions, [reference](./reference/)
  for normative matrices and generated artifacts, and [milestones](./milestones/)
  for frozen implementation/evidence records.
- Use the generated [package SBOM](./reference/package-sbom.json) for the
  current npm candidate; `sbom.json` remains the frozen M9 inventory.
- Use [release notes](./releases/release-notes.md) for the M9 MVP candidate,
  migration, and rollback record.
- Use the approved [versioning and release policy](./guides/versioning-and-releases.md)
  for the distinct product, MCP contract, persistence, XML, and native-runtime
  version axes; registry publication remains separately authorization-gated.
- Use [audits](./audits/) for evidence-only review records.

The [documentation policy](./documentation-policy.md) defines names, authority,
and lifecycle. The complete issue #25 disposition is frozen in the
[documentation inventory](./audits/documentation-inventory-2026-08-29.md).
Repository-internal agent process documents live under [`.agents`](../.agents/)
and are not end-user product guides.
