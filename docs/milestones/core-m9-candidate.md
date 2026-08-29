# M9 Local Release Candidate

Gate: `bash scripts/gates/check-m9-candidate.sh`. Record generator:
`node scripts/tools/m9-release-candidate.mjs ABSOLUTE_OUTPUT_DIRECTORY`.
This is the local release candidate defined by issue #21. It does not publish,
package, bundle, or create a GitHub release.

## Candidate identity and freeze contract

The candidate identity is the SHA-1 Git tree object returned by
`git write-tree`, not a commit, branch name, working-directory hash, or archive
hash. Before freezing, the generator requires:

- zero tracked differences between the working tree and the index;
- zero non-ignored untracked files;
- a writable, empty output directory outside the repository.

The source revision (`git rev-parse HEAD`) is recorded separately because a
staged tree may differ from its base commit. The generator archives the tree
object itself, so ignored `node_modules`, `dist`, MCP state, editor files, and
other local state cannot enter the checkout. Manifest and evidence are emitted
outside the candidate tree: embedding its digest inside that same tree would
create an impossible self-reference.

## Manifest and evidence

`manifest.json` records the tree and source revision, package/contract version,
Ubuntu/Node/Ipe/XML baseline, exact toolchain versions, lockfile version and
SHA-256, check contracts, and bounded artifact metadata. `evidence.json`
records the observed PASS result for every check, the normalized workflow
result, the same artifact hashes, and cleanup status.

Both files are stable JSON with fixed fields and no timestamp, random
document ID, elapsed time, hostname, username, absolute path, token, process
log, or generated binary. With the same staged tree, source revision,
dependency lock, and toolchain, a repeated successful run produces the same
records.

The four exercised artifacts are the editable Ipe XML, PDF export, PNG export,
and PNG preview. They are checked for non-zero size and their native signature;
the Ipe file must declare format `70218`. Only name, media type, byte size, and
SHA-256 are retained in the records.

## Clean-checkout procedure

The isolated tree runs:

1. `npm ci --no-audit --no-fund` with no inherited dependencies;
2. `npm run build`;
3. the complete stable Vitest suite in two serialized lanes: the native
   adapter file first, then every remaining file with that path excluded. This
   keeps its explicit 30-second native integration budget independent from earlier
   tests while the default tests use the repository's 30-second native-process
   ceiling;
4. the real MCP stdio M9 agent workflow: create/open, author/layout, stale-write
   rejection, structural/full validation, render, save, reopen, PDF/PNG export,
   snapshot, undo/restore, restart recovery, and protocol-safe stderr;
5. format/hash auditing followed by removal of the checkout, dependency tree,
   generated state, logs, and binary artifacts.

The gate creates its record directory under a private `mktemp -d` root and
removes it on exit. To retain the two release records intentionally, create an
empty directory outside the repository and pass its absolute path directly to
the generator. No temporary root or artifact is retained by default.

## Scope boundaries

There is no npm publication, GitHub Release, distributable bundle, marketplace,
or multiplatform package. Those remain M10 decisions. Issue #8 agentic-harness
compliance is not affected: this work changes no MCP tool description, host
instruction, task payload, or agent harness. The exercised stdio workflow and
the existing M8 gate remain the inherited MCP evidence; a new full Issue #8
audit is therefore not applicable to this candidate-freeze mechanism.
