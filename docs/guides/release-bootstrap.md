# First npm Release Bootstrap

Lifecycle: **Maintained**. Audience: release owner. This guide prepares the
first public `ipe-mcp@1.0.0-rc.1` release. It does not itself authorize a tag,
npm publication, dist-tag change, or GitHub Release.

## Why the first release is different

npm requires a package to exist before trusted publishing or staged publishing
can be configured. The first publication therefore uses one short-lived
granular npm token from the protected `npm-release` GitHub environment. The
GitHub-hosted job also has `id-token: write`, so npm records provenance for the
published tarball.

After the first release, the temporary credential is removed and the workflow
is converted to trusted, stage-only publishing. Future versions require a human
2FA approval in npm before they become public.

## Inert verification

After the release-preparation PR is merged, run the workflow without any npm
credential and without a tag:

```bash
gh workflow run release-candidate.yml \
  --ref main \
  -f mode=verify-only
gh run watch --exit-status
```

The verification job uses a fresh GitHub-hosted Ubuntu 26.04 runner, pins Node
24 and npm 11.16.0, installs the separately packaged native prerequisites, runs
the full M10 package gate, creates the candidate tarball and manifest, and
uploads a temporary workflow artifact. It cannot enter the publication job.

## Protected GitHub environment

Create `npm-release` only after verify-only passes:

1. restrict deployments to selected tags matching `v*`;
2. require the repository owner as a reviewer;
3. keep self-review available when the owner is the only maintainer, otherwise
   the release would be impossible to approve;
4. disallow administrator bypass when the repository plan exposes that option;
5. add no credential until the exact candidate is ready for publication.

Before publication, protect `main` against force-push/deletion and keep changes
on the reviewed pull-request path. The release script independently requires
the annotated version tag to resolve to the current `origin/main` commit.

The workflow also rejects `bootstrap-publish` unless it is dispatched from the
exact tag matching the version in `package.json`.

## Owner-only bootstrap credential

Immediately before the separately authorized first publication, the owner must:

1. sign in to npm and ensure account-level 2FA is enabled;
2. create a granular write token with bypass-2FA capability and the shortest
   practical expiration for this one bootstrap run;
3. store it as the `NPM_TOKEN` secret in the `npm-release` environment, never in
   a repository file, issue, chat, shell history, workflow input, or log;
4. approve the waiting GitHub environment deployment only after reviewing the
   exact tag, commit, package manifest, SBOM, and release notes.

The assistant must stop before tag creation and again before triggering
`bootstrap-publish` unless the owner has explicitly authorized those actions.

## Authorized publication sequence

Only after explicit owner authorization:

1. rerun `npm run check:m10:package` and `npm run check:m10:release` on clean
   `main`;
2. create and push annotated tag `v1.0.0-rc.1` at the reviewed commit;
3. dispatch `release-candidate.yml` from that tag with
   `mode=bootstrap-publish`;
4. review and approve the `npm-release` environment deployment;
5. let the workflow publish the exact retained tarball with npm tag `next` and
   provenance;
6. verify registry integrity, provenance/signatures, and that `latest` did not
   change;
7. create the matching GitHub prerelease with tarball, manifest, and
   SBOM assets.

The workflow is restart-safe: if npm already contains the exact immutable
version with the expected integrity, it skips republishing and continues the
registry/GitHub Release verification. A different integrity fails closed.

## Immediate post-bootstrap hardening

Once `ipe-mcp` exists on npm, before another version is prepared:

1. configure npm trusted publishing for repository `Mik1810/ipe-mcp`, workflow
   filename `release-candidate.yml`, and environment `npm-release`;
2. grant only `npm stage publish`, not direct `npm publish`;
3. set package publishing access to require 2FA and disallow normal tokens;
4. delete the `NPM_TOKEN` GitHub environment secret;
5. revoke the temporary npm token;
6. update the workflow in a reviewed PR to use `npm stage publish` without
   `NODE_AUTH_TOKEN`;
7. verify future staged tarballs before approving them interactively with 2FA.

Trusted-publisher and staged-package settings require the npm account owner and
cannot be inferred from a successful GitHub workflow.

## Recovery

If publication fails before npm accepts the tarball, delete the environment
secret, revoke the token, diagnose the bounded workflow output, and prepare a
new run. Do not overwrite or reuse a version that npm accepted. If npm succeeds
but GitHub Release creation fails, rerun the exact tagged workflow: its integrity
guard skips npm publication and repairs only the missing release record.
