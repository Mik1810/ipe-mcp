# 0011. Qualify Ubuntu 26.04 amd64 on native Linux

## Decision

Use the GitHub-hosted `ubuntu-26.04` amd64 VM for the first non-WSL lane.
The distribution matches the WSL baseline and provides the Ipe 7.2.30
toolchain for stable XML 70218. The workflow records the runner image,
kernel, package versions and APT provenance on each run. It checks
distribution and architecture and rejects WSL kernels and container runs.

Use the Ubuntu archive packages for Ipe, TeX Live, Lua, Poppler, MuPDF,
Bubblewrap and util-linux. Use signed Ubuntu metadata over HTTPS. The TeX
installation includes `texlive-latex-recommended` for the `xcolor` path
exercised by the Ipe colour fixtures. Native operations run under the same
unprivileged
Bubblewrap and prlimit policy as the WSL baseline. A negative probe hides
Bubblewrap ownership evidence in an isolated mount namespace and checks
that the runtime refuses to spawn. Package ownership,
tool versions and verified native capabilities are required before running
the cumulative M0–M8 checks, M9 limits, hostile and real-document gates, and
the clean package install with a portable SDK stdio scenario. The real
corpus gate compares current results with its recorded native passes and
classified outcomes. Only tracked public fixtures and distro packages enter
the run.

## Scope

This decision qualifies one headless source and package verification lane.
The support policy names qualified revisions and evidence. Desktop Ipe
integration, other distributions and architectures require their own checks.
WSL retains its separate baseline and release qualification. Use the
non-WSL evidence as input to the container decision in #36.
