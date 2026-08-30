# ADR-0005 — Distribution, Versioning, and Native Dependencies

- Status: **Accepted**
- Date: 2026-08-30
- Decision issue: [#30](https://github.com/Mik1810/ipe-mcp/issues/30)
- Implementation issue: [#31](https://github.com/Mik1810/ipe-mcp/issues/31)

## Context and User Problem

The M9 candidate is usable from a source checkout but is not an installable
public product. A user currently has to clone the repository, install the
locked npm dependencies, build TypeScript, install the native toolchain, and
configure an MCP host manually. The repository also has no Git tags or GitHub
Releases, and its current package (`0.1.0`) is private.

Distribution must make the stable stdio server easier to install without
silently broadening the supported platform matrix, bundling copyleft native
programs, running privileged installers, or making publication an incidental
side effect of a build. It must also distinguish the product version from the
MCP contract, persistence schema, Ipe XML format, and Ipe runtime version.

## Distribution Goals

- Provide one small, inspectable npm package with the `ipe-mcp` stdio command.
- Keep native programs outside the npm artifact and make their ownership clear.
- Fail closed with actionable capability diagnostics when native prerequisites
  are absent, untrusted, or unsupported.
- Produce a traceable artifact from a reviewed Git revision with an SBOM,
  integrity data, release notes, and a tested rollback path.
- Preserve the M9 security, privacy, write-safety, and support boundaries.
- Make building and validating an artifact different from publishing it.

## Decision

The selected model is a **thin npm helper** containing the compiled JavaScript
stdio server, type declarations,
the CLI entry point, package metadata, the MIT license, and essential install
and support documentation.

The npm package will not contain, download, install, wrap, or relink Ipe, TeX,
Poppler, MuPDF, bubblewrap, Lua, or platform equivalents. It will have no
install lifecycle script that mutates the host. Native discovery remains a
runtime capability probe. The first supported packaged lane remains Ubuntu
26.04 on WSL2 with the same versions and provenance checks as M9.

Publication is not authorized by this ADR. Issue #31 may make the package
packable and test it from a local tarball. A registry publish, GitHub Release,
or `latest` dist-tag change requires a separate explicit owner authorization
after the packaging gate passes.

## Considered Strategies

| Strategy | Decision | Rationale |
|---|---|---|
| Thin npm helper, native tools installed separately | **Selected, pending approval** | Smallest artifact; preserves the subprocess boundary; matches the TypeScript/MCP host ecosystem; supports tarball install and rollback by exact version. |
| Source-checkout installable helper | Superseded as the primary distribution | Useful for contributors and recovery, but makes build tooling and repository internals part of the user installation and does not provide a clean release artifact. |
| Bundle native executables with npm | Rejected | Enlarges the trust and support surface, complicates platform packaging, and requires a materially different GPL/AGPL distribution review. |
| OS/system package containing server and native stack | Deferred | Could provide strong native provenance, but would require per-distribution maintainership and does not solve MCP-host installation across platforms yet. |
| Container/devcontainer | Deferred to #36 | Does not integrate naturally with local stdio files and GUI workflows until the native packaged lane is validated. |

## Native Dependency Ownership

| Component | Installed by | Required for | Package responsibility |
|---|---|---|---|
| Node.js and npm | User or system administrator | Server runtime and installation | Check the declared Node engine; never install Node. |
| Ipe and Lua/Ipelib | User or system package manager | Native load/save/style/LaTeX operations | Detect executable, version, runtime coherence, and package provenance. |
| TeX (`pdflatex`) | User or system package manager | Native text validation | Detect and report missing/unsupported capability. |
| Poppler (`pdfinfo`, `pdftoppm`) | User or system package manager | PDF inspection and rasterization | Detect executable and owning package. |
| MuPDF (`mutool`) | User or system package manager | Independent PDF validation | Detect executable and owning package; never bundle it. |
| bubblewrap and `prlimit` | User or system package manager | Process isolation and limits | Require them for the supported full lane; otherwise degrade or reject exactly as the support policy states. |

The package manager must not invoke `sudo`, `apt`, a shell download, or another
privileged/native installer. Documentation may provide explicit commands for
the user to review and run separately.

## Versioning Decision

The distributable server follows Semantic Versioning:

- `0.1.0` remains the historical M9 local release candidate.
- The first registry candidate will be `1.0.0-rc.1`.
- `1.0.0` will be promoted only after the packaged tarball passes the complete
  gate, the approval record is complete, and publication is explicitly
  authorized.
- Patch releases fix behavior without breaking the public package or
  `ipe-mcp/1` contract.
- Minor releases add backward-compatible behavior.
- Major releases may break the public product API. A breaking tool-result
  contract also requires a new contract major such as `ipe-mcp/2`.

`package.json` is the single source of the product version. Server metadata,
release tooling, the package lock root, the SBOM root component, and release
notes must derive from or verify against it rather than hard-code a second
value. The maintained policy is
[`versioning-and-releases.md`](../guides/versioning-and-releases.md).

These independent axes must never be inferred from one another:

| Axis | Current baseline | Compatibility meaning |
|---|---|---|
| Product/package | `0.1.0` candidate | SemVer release and installation identity |
| MCP result contract | `ipe-mcp/1` | Model-facing tool-result compatibility major |
| Sidecar schema | `1` (with v0 → v1 load migration) | Persistence compatibility |
| Ipe XML | `70218` | Serialized document format |
| Native Ipe | `7.2.30` | Supported runtime/toolchain lane |

## Provenance, Integrity, Updates, and Rollback

- Build from a clean reviewed Git revision using the committed npm lockfile.
- Produce the tarball before publication and retain its filename, size,
  SHA-256, SHA-512/integrity value, package manifest, and CycloneDX SBOM.
- Create an annotated `vX.Y.Z` Git tag and a matching GitHub Release only from
  the gated revision. A stable release must not be tagged from a dirty tree.
- Prefer registry provenance from a protected CI release environment with
  short-lived identity. Long-lived publication credentials must not be stored
  in the repository, package, logs, fixtures, or release evidence.
- Do not auto-update installations. Users and hosts select an exact version or
  an npm dist-tag explicitly.
- Roll back by installing the previous exact package version, restarting the
  MCP connection, and re-querying orientation/capabilities. Document and
  sidecar compatibility must be checked before a major downgrade.
- A release is never overwritten. A defective version is deprecated and a new
  SemVer version is issued; registry unpublish is reserved for a security or
  legal emergency and requires explicit owner action.

## Licensing Boundary and Required Review

The server source and npm dependency graph are MIT-compatible according to the
M9 inventory. Ipe (GPL-3+), Poppler (GPL), MuPDF (AGPL-3+), and other native
tools remain separately installed system programs invoked as subprocesses.
No native source or binary is copied into the npm artifact.

This is a technical boundary record, not legal advice. The owner reviewed and
accepted the thin-package boundary without requesting external legal counsel:
the selected artifact distributes the MIT server and its npm dependency graph,
not the separately installed native programs. Any future native bundle,
HTTP/SaaS offering, or change from subprocess execution reopens the review.

## Threat and Trust Boundary Update (`TM-DIST`)

Distribution adds risks of publishing repository/private state, dependency or
package-name confusion, lifecycle-script execution, forged artifacts,
untrusted executables on `PATH`, credential leakage, and silent auto-update.

Mitigations are an explicit package `files` allowlist, a deny-list audit, no
native binaries, no install lifecycle mutation, clean-tarball installation,
locked dependencies, artifact integrity/provenance, secret scanning, native
executable ownership/version probes, and an explicit publication approval
step. The package performs no telemetry or network access during stdio startup
or capability discovery.

The package writes only through the existing workspace/state-root rules after
an MCP tool request. Installation must not create or migrate user documents,
workspace state, or global MCP configuration.

## Capability Probe Specification

The packaged CLI must expose the existing structural/full capability result
without requiring native work first. On the supported lane, the probe must:

1. verify platform and architecture;
2. resolve required executables without invoking a shell;
3. verify Debian package ownership and coherent supported versions;
4. distinguish missing, unsupported, unowned, and mismatched tools;
5. report `structural-only` or `full-7.2.30` without installing anything;
6. redact environment values and local paths according to the existing MCP
   diagnostics policy.

Other platforms remain unsupported until their dedicated capability and CI
issues pass. Package installation alone is not evidence of native support.

## Packaging Gate Specification

Issue #31 must implement one reproducible command that fails unless all of the
following are true:

1. **Metadata:** package name/version/license/repository/engines/bin are
   complete; package, lock root, server metadata, SBOM, and release notes agree.
2. **Contents:** `npm pack --json` matches an explicit allowlist and excludes
   secrets, local state, VCS/editor/agent configuration, tests, fixtures,
   audits, source maps unless justified, and native GPL/AGPL programs.
3. **Install:** a clean temporary project installs the produced tarball with
   lifecycle scripts disabled and can execute `ipe-mcp` without repository or
   inherited `node_modules` state.
4. **Protocol:** the installed tarball completes MCP initialize, orientation,
   capability discovery, and the provider-neutral stdio smoke scenario from
   #28; stdout stays protocol-only and diagnostics remain redacted.
5. **Native lane:** the same tarball passes the supported full capability probe
   and the smallest create/validate/render/export scenario on Ubuntu 26.04 WSL.
6. **Supply chain:** the dependency lock, tarball manifest, integrity hashes,
   SBOM, license inventory, and provenance inputs are complete and contain no
   publication credential.
7. **Rollback:** the immediately previous candidate can be installed by exact
   version and restarted without implicit document/state migration.
8. **Separation:** the gate creates no Git tag, GitHub Release, registry
   package, dist-tag change, global configuration, or native installation.

## Support Consequences

An installable npm artifact changes the installation method, not the verified
native support matrix. Until the platform issues pass, only Ubuntu 26.04 WSL2
may be described as the full supported packaged lane. Structural-only startup
may work elsewhere, but that is capability detection rather than a support
claim.

## MCP Harness Compliance

- `permissions-and-write-safety`: installation has no privileged/native
  mutation; publishing and user-document writes remain explicit actions.
- `transport-integration-and-privacy`: stdio only; no telemetry, HTTP, secrets,
  or implicit host configuration is introduced.
- `code-architecture-and-verification`: product and contract versions are
  separated; the tarball receives clean-install, protocol, native, SBOM, and
  rollback gates.

## Approval Record

- Technical owner approval: **ACCEPTED — Michael Piccirilli, 2026-08-30**
- License/legal boundary review: **OWNER ACCEPTED — Michael Piccirilli,
  2026-08-30; external counsel not requested for the selected thin package**
- Public distribution authorization: **NOT GRANTED by this ADR**

Acceptance does not authorize publication. Issue #31 must first implement and
pass the packaging gate, after which publication still requires a separate
explicit owner authorization.
