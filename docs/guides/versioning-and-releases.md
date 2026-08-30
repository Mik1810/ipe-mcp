# Versioning and Release Policy

Lifecycle: **Maintained**. Audience: maintainers, release reviewers, package
consumers, and MCP host integrators. This guide is the operational versioning
policy approved by ADR-0005. Issue #31 implemented and passed the packaging
gate; release issue #50 prepares the protected first-publication bootstrap.
No public release is authorized until the owner separately authorizes the exact
tag and publication workflow run.

## Independent Version Axes

| Axis | Example | Changes when |
|---|---|---|
| Product/package SemVer | `1.2.3` | A distributable server release changes. |
| MCP result contract | `ipe-mcp/1` | Public tool-result compatibility changes. |
| Sidecar schema | `schemaVersion: 1` | Persisted metadata needs a migration. |
| Ipe XML format | `70218` | The serialized Ipe file baseline changes. |
| Native Ipe runtime | `7.2.30` | A capability/support lane is adopted. |

The numbers are intentionally independent. Product `1.0.0` does not imply
Ipe 1, XML format 1, or a sidecar migration. A product minor release may keep
`ipe-mcp/1`; a breaking result-contract change requires both a new product
major and a new contract major.

## Semantic Versioning Rules

- **Patch** (`1.0.0` → `1.0.1`): compatible fixes, diagnostics corrections,
  and security patches that do not remove supported behavior.
- **Minor** (`1.0.0` → `1.1.0`): backward-compatible tools, inputs, result
  fields, or supported capabilities. Existing `ipe-mcp/1` consumers continue
  to work.
- **Major** (`1.x` → `2.0.0`): incompatible package, CLI, or product behavior.
  An incompatible public tool-result contract also changes to `ipe-mcp/2`.
- **Prerelease** (`1.0.0-rc.1`): gated candidate without a stability promise;
  subsequent candidates increment the numeric suffix.

Removing a tool, renaming a public field, tightening an accepted input in a
way that rejects previously valid calls, or changing persistence without a
compatible migration is a breaking change. Adding optional fields and new
tools is normally minor, but must still preserve bounded output and host
compatibility.

## First Public Release Line

The M9 source-checkout candidate remains `0.1.0`. The repository package
metadata now identifies the locally gated candidate as `1.0.0-rc.1`; it is not
published. The first packaged line is:

```text
0.1.0 (historical local candidate)
  -> 1.0.0-rc.1 (first gated tarball candidate)
  -> 1.0.0-rc.N (corrections, if required)
  -> 1.0.0 (first explicitly authorized stable publication)
```

Prereleases use the npm `next` dist-tag. Only an explicitly approved stable
release may update `latest`.

## Single Product-Version Source

`package.json` is the product-version source of truth. The following must
derive from it or fail a release consistency gate:

- package-lock root version;
- MCP server `serverInfo.version`;
- generated SBOM root component and package URL;
- tarball filename and manifest;
- release notes heading/identity;
- Git tag and GitHub Release name.

The MCP contract constant remains separate and must not be generated from the
package major.

## Candidate and Release Procedure

1. Select a clean reviewed Git revision and choose the SemVer change.
2. Update the package version without changing the MCP contract unless the
   compatibility analysis requires it.
3. Build the tarball and run the packaging gate specified by ADR-0005.
4. Review the exact manifest, integrity hashes, SBOM, licenses, support matrix,
   migration notes, and rollback command.
5. Obtain the approval required by ADR-0005.
6. With separate publication authorization, create annotated tag `vX.Y.Z`,
   publish from the protected release environment with provenance, create the
   matching GitHub Release, and verify the registry artifact by digest.

The first publication is a documented bootstrap exception because npm requires
a package to exist before trusted publishing or staged publishing can be
configured. It uses one short-lived environment-scoped npm credential on a
GitHub-hosted runner with provenance. Immediately afterward, configure the
workflow as the package's trusted publisher with stage-only permission, require
2FA and disallow normal publishing tokens, then delete the bootstrap secret and
revoke the credential. Future releases are staged by CI and approved by a human
with 2FA.

Steps 5 and 6 are never implied by a successful build, merge, tag proposal, or
gate. Normal CI and pull requests must not possess publication authority.

## Updates and Rollback

There is no background updater. Operators choose an exact SemVer or an npm
dist-tag. For reproducible host configuration, pin the exact version.

Rollback installs the previous exact version, restarts the MCP connection, and
re-queries orientation and capabilities. Before a major downgrade, review the
sidecar schema and document migration notes. Releases are immutable: correct a
bad release with a new version and deprecate the old one rather than replacing
its tarball.

Registry unpublish, dist-tag rollback, or revocation is an explicit owner
action reserved for a security or legal emergency.
