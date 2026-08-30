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

The workflow rejects both `stage-publish` and `finalize-release` unless they are
dispatched from the exact tag matching the version in `package.json`.

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
`stage-publish` unless the owner has explicitly authorized those actions.

## Authorized staged publication sequence

After bootstrap, only the following staged flow is supported, and tag creation
plus staging still require explicit owner authorization:

1. rerun `npm run check:m10:package` and `npm run check:m10:release` on clean
   `main`;
2. create and push the annotated version tag at the reviewed commit;
3. dispatch `release-candidate.yml` from that tag with
   `mode=stage-publish` and approve the `npm-release` environment deployment;
4. inspect the pending package with `npm stage list`, `npm stage view`, and
   `npm stage download`, then approve its stage ID with `npm stage approve`
   and interactive 2FA;
5. dispatch the same workflow and tag with `mode=finalize-release`, approve the
   protected environment, and let it verify the now-public registry artifact;
6. let finalization verify registry integrity and provenance/signatures,
   require `next` to select the candidate, and preserve the stable `latest`
   line;
7. create or verify the matching GitHub prerelease with tarball, manifest, and
   SBOM assets.

`stage-publish` has `id-token: write` but only read access to repository
contents. `finalize-release` can create the GitHub Release but has no npm write
credential and no OIDC permission. Neither job contains `NODE_AUTH_TOKEN`.

The staging command is intentionally not restart-safe because npm reserves the
version as soon as it is staged. If staging is interrupted, inspect the pending
stage instead of submitting the same version again. Finalization is
restart-safe: it does not publish and can repair a missing GitHub Release after
the exact npm version becomes public.

## Completed first-release bootstrap

The one-time `1.0.0-rc.1` bootstrap from tag `v1.0.0-rc.1` used the former
`mode=bootstrap-publish` path:

1. the owner approved the `npm-release` environment;
2. the workflow published the retained tarball with npm tag `next` and
   provenance;
3. registry integrity, provenance/signatures, and npm's mandatory initial
   `latest` alias were verified;
4. the matching GitHub prerelease was created with tarball, manifest, and SBOM
   assets.

That direct-publish mode and its `NPM_TOKEN` dependency are removed after the
bootstrap.

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

If staging fails before npm reserves the version, diagnose the bounded workflow
output and prepare a new run. If npm has reserved the stage, inspect, approve,
or reject that exact stage instead of staging the version again. Do not
overwrite or reuse a version that npm accepted. If approval succeeds but
GitHub Release creation fails, rerun `finalize-release` from the exact tag; it
performs no npm write and repairs only the missing release record.
