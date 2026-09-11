# Agent Note: Fork CI and desktop release configuration

Status: implemented

English | [中文](2026-09-11-fork-ci-and-desktop-release-configuration.zh.md)

## Problem

This repository is a long-lived fork of `deepseek-ai/deepseek-harness` that takes upstream updates and contributes nothing back. The inherited continuous-integration arrangement assumes the upstream account.

The upstream `ci.yml` routes its required jobs to organization-restricted runner pools (`dsh-ubuntu-24-04-16core`, `dsh-windows-2025-16core`) and to self-hosted labels (`[self-hosted, linux, x64, vm-backup]`, `[self-hosted, dsh-win-ci, windows]`). None of those exist for this account, so a run queues until it times out instead of reporting a verdict, and a timed-out job is indistinguishable from a slow one until it expires. Several other inherited workflows either require credentials this fork does not hold or publish to registries and sites it does not own.

The fork therefore had no usable signal, on a branch where the desktop distribution is about to start landing changes to the harness composition.

A second problem was local rather than repository-wide. Every `check:ci:*` aggregate failed immediately with thirty-five failures whose shared cause was invisible: `scripts/run-gates.ts` spawns each gate as `node <npm_execpath> ...`, and the `@pnpm/exe` distribution installed by the version manager points `npm_execpath` at a native binary. Separately, package scripts that invoke `pnpm` by name resolve a version that does not match the `packageManager` field and refuse to run.

## Decision

### The fork owns its checks

`.github/workflows/fork-ci.yml` carries the fork's signal and uses only standard GitHub-hosted runners, which have no minute quota for a public repository. Four jobs run: the static gate aggregate, the unit tests, the keyless snapshot replay, and a macOS lane running typechecking and the tests.

The macOS lane exists because the desktop distribution targets macOS and depends on platform-specific behavior that a Linux run cannot exercise: the `node-pty` addon, the Seatbelt sandbox rung, and the process inspection the persistent terminal backend performs.

### Inherited workflows are disabled through settings, not by editing

Upstream workflow files stay byte-identical to their upstream state and are disabled through repository settings. Editing them would add seven files to the fork's divergence set and would have to be re-resolved at every upstream fetch; a setting is not carried by a fetch and needs no maintenance.

Their publication steps cannot fire from here regardless, because each is a manual dispatch guarded by an environment and a tag check. The automatic steps that do run only pack tarballs without credentials. Disabling is therefore about runner time and about the upstream `ci.yml` producing a misleading queued run, not about preventing a publication.

A workflow file is registered by GitHub only after the first push to the fork. Disabling is consequently a step taken after that push, not before it.

The dispositions are recorded in [`desktop/docs/releases/v0.0.1/distribution.md`](../../../../desktop/docs/releases/v0.0.1/distribution.md): the workflows that would fail or waste runner time are disabled, and the ones that already use standard runners and would still produce a useful signal are kept.

### The release environment is created before the release workflow

The `desktop-release` environment restricts deployments to tags matching `desktop-v*` and requires a reviewer before a deployment proceeds. Creating it before the workflow that consumes it means the first release cannot publish without approval, rather than gaining protection only after someone remembers to add it.

### pnpm must be a JavaScript entry point

The requirement is stated in [`desktop/README.md`](../../../../desktop/README.md) rather than worked around in `scripts/run-gates.ts`. The script's `node <npm_execpath>` invocation is correct for the pnpm distributions CI installs, and the native-binary distribution is the anomaly: it is not executable by `node`, and it is not the version the repository pins. Weakening the invocation to accommodate it would hide a genuine misconfiguration behind a fallback.

## Conditions the fork's first run surfaced

Running the inherited gates on standard hosted runners rather than the upstream pools surfaced four conditions that the upstream arrangement does not exercise. Each is recorded because it is a property of the harness or of a stock runner image, not of this fork's configuration.

**The archive baseline must be absent rather than empty.** [`scripts/verify-archived-agent-notes.ts`](../../../../scripts/verify-archived-agent-notes.ts) resolves its baseline as `process.env.DSH_ARCHIVE_BASE_REF ?? 'HEAD'`, so an unset variable falls back to `HEAD` while an empty string is used as-is and fails `git rev-parse`. The expression in the upstream pull-request job resolves to the empty string under any other event, which is harmless there because that job is pull-request-only. The fork's workflow runs on pushes too, so it resolves the baseline in a step and leaves the variable unset when the event carries no usable commit.

**The standard Ubuntu image ships PowerShell.** The `pwsh-tool-turn` scenario's skip guard probes whether a `pwsh` executable runs, while the composition that mounts the pwsh tool is gated to win32. On a Linux host that has the binary, the guard admits a scenario whose composition cannot mount the tool, and the request header diverges. Upstream's Linux pools carry no pwsh, so the mismatch stays invisible there. The fork's snapshot job removes the preinstalled binary, which restores the condition the guard is written for.

**A fixture in that scenario also carries stale wording.** Its `job_kill` reason description reads `forwarded to the task` where the source and every other fixture read `job`. The scenario cannot run on any host whose composition mounts no pwsh tool, which is the same reason the staleness was not caught. Neither the guard nor the fixture is corrected here: both are upstream-owned, and the fork's divergence budget covers only the additive list insertions recorded in [`desktop/README.md`](../../../../desktop/README.md).

**The replayed scenarios need bubblewrap.** The sandbox's Linux chain resolves bubblewrap before Landlock, and a stock hosted image supplies neither the binary nor an unrestricted unprivileged user namespace. [`scripts/prepare-ci-bubblewrap.sh`](../../../../scripts/prepare-ci-bubblewrap.sh) supplies both; the upstream consumer lane runs it, and the fork's snapshot job now does too.

## Alternatives considered

**Edit the upstream workflows in place to retarget their runners.** Rejected: it converts seven upstream-owned files into merge conflicts at every fetch, to obtain a signal that a separate workflow file provides without touching them.

**Delete the upstream workflows.** Rejected: deletion is also a divergence, and it loses the file contents that a future fetch would otherwise re-add. A setting is reversible and leaves the tree tracking upstream.

**Leave the upstream workflows enabled and ignore the failures.** Rejected because a queued-then-timed-out required job is worse than no job: it costs runner allocation and produces a verdict that reads like a real failure while carrying no information.

**Retarget the fork's jobs onto self-hosted runners.** Rejected: no such runners exist for this account, and the desktop work does not need them. Standard runners run the static aggregate in under two minutes.

**Weaken `run-gates.ts` to tolerate a native pnpm.** Rejected for the reason above: the invocation encodes a real requirement, and the anomaly is a local toolchain choice rather than a repository constraint.

**Correct the `pwsh` scenario's guard and its stale fixture.** Rejected: both files are upstream-owned, so either edit becomes a merge conflict at every fetch. The guard's defect is real — it tests for a binary where the composition tests for a platform — and the fork records it rather than repairing it, because repairing it delivers no signal the fork needs. A contribution upstream would be the home for that fix, and this fork does not contribute.

**Skip the snapshot lane on the fork.** Rejected: seventeen of its nineteen files pass and cover the assembled compositions the desktop distribution boots. Removing the environment conditions the lane needs would discard that coverage to avoid two known, explained divergences.

## Consequences

**Bought**: a fork signal that reports a verdict instead of timing out; a macOS lane covering the platform the desktop distribution targets; a release path whose first publication already requires approval; and a documented cause for a failure mode whose thirty-five symptoms point at individual gates rather than at the toolchain.

**Paid**: seven upstream workflow files remain in the tree in a disabled state that is invisible from the source, so a reader of `.github/workflows/` cannot tell from the files alone which ones run. The disposition table in the release documentation is the only record. Adding a workflow to this repository now requires deciding its disposition on both sides of the fork boundary.

**Not yet resolved**: notarization credentials are not configured, so a locally built DMG is signed but carries no notarization ticket. [`desktop/docs/releases/v0.0.1/packaging.md`](../../../../desktop/docs/releases/v0.0.1/packaging.md) records that distinction as a release prerequisite rather than a build step.
