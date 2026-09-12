# Risks

Status: Proposed

This document records what is unverified, what could fail, what each fallback is, and what triggers it.

## Verification status

The design rests on harness facts that were read from source and on packaging facts that are not yet exercised in this configuration. The distinction matters when deciding what to test first.

| Claim | Status | Evidence |
|---|---|---|
| Bare-specifier resolution requires Loader internals | Verified by reading source | [`vendor/loader/src/config/tree.ts`](../../../../vendor/loader/src/config/tree.ts) and the contract statement in [`packages/boot/app-boot/README.md`](../../../../packages/boot/app-boot/README.md) |
| `--expose-internals` is consulted before the native helper | Verified by reading source | [`vendor/loader/src/internal.ts`](../../../../vendor/loader/src/internal.ts) |
| The profile launcher installs a process-exiting handler and forces an HMR mount | Verified by reading source | [`apps/cli/src/profile-boot.ts`](../../../../apps/cli/src/profile-boot.ts) and [`vendor/hmr/src/index.ts`](../../../../vendor/hmr/src/index.ts) |
| `node-pty` is imported eagerly and must load at boot | Verified by reading source | [`packages/subprocess/subprocess-local/src/index.ts`](../../../../packages/subprocess/subprocess-local/src/index.ts) |
| The persistence backend eagerly imports `node:zlib` zstd | Verified by reading source | [`packages/session/session-persistence-jsonl/src/zstd.ts`](../../../../packages/session/session-persistence-jsonl/src/zstd.ts) |
| `node-addon-require-builtin` is avoidable | **Unverified in Electron** | The code path is verified; that Electron's Node satisfies it is a Stage 0 item |
| `node-pty` loads against Electron's ABI with the helper path the patch probes | **Unverified** | The patch is written for this shape; no Electron build has been exercised |
| The frozen closure serves the interface | **Unverified** | Composed of verified facts about path resolution, but the combination is a Stage 0 item |
| Electron 39's Node 22.20 satisfies the engine floor | Verified from release notes, not from a running build | Confirmed against the published Electron release, to be re-confirmed from `process.versions` in the spike |

## Risk register

Likelihood and impact are recorded so the ordering of mitigation is deliberate rather than incidental.

| Risk | Likelihood | Impact | Mitigation or fallback |
|---|---|---|---|
| `--expose-internals` does not reach Node internals in an Electron child process | Medium | High — blocks the selected carrier | Stage 0 tests it first. Fallback: the bundled official Node carrier, which is a shipping decision, not a redesign |
| `node-pty` cannot be rebuilt against Electron's ABI | Low | High — blocks boot, not just PTY features | Stage 0 tests it. Fallback: the bundled Node carrier, where it builds against stock Node as it does in CI today |
| The frozen closure fails to serve the interface | Low | High — invalidates the composition | Stage 0 tests it. This is the only failure whose repair touches the composition rather than the carrier |
| A nested binary is rejected by notarization | Medium | Medium — blocks publication until the offending file is fixed | Notarization reports the offending file and reason, so the repair is localized to one artifact's signing or entitlements. A release candidate is notarized before the release is tagged, so the round trip happens off the critical path |
| Notarization credentials are validated but not yet in CI | Medium until Stage 3 | Low — a release built by hand is notarized, a release built by the pipeline is not | Signing works locally from the login keychain, and the API key is validated against the notary service. Moving both into CI secrets is part of Stage 3, and [`packaging.md`](packaging.md) records what each secret is |
| The Developer ID certificate expires | Certain, on 2027-02-01 | High — every published release stops being verifiable and updatable, including versions already installed | The expiry is recorded rather than rediscovered. Renewal is a certificate replacement with the same team identifier, so installed applications keep accepting updates |
| Nested binaries are signed in the wrong order or with the wrong identity | Medium | Medium — Gatekeeper rejects the application on a user's machine | Verification runs against the built bundle on a clean machine, not against the build tree |
| An update downloads but cannot be applied | Medium | Medium — the user is stranded on an old version | The About surface offers the release page as a manual path. Updates require a writable install location, which the DMG flow provides and a run-from-DMG does not |
| macOS `sandbox-exec` is removed in a future release | Low | High — the sandbox chain fails closed and the agent stops executing commands | Recorded as a platform dependency. Nothing in this release can mitigate it; the harness's sandbox seam is where it would be addressed |
| `--expose-internals` and Loader internals change across a Node or Electron upgrade | Medium over time | High — boot failure after an upgrade | The Electron line is pinned and upgraded deliberately. The verification stage catches it before publication because it boots the packaged artifact rather than the build tree |
| Closure size makes the download unacceptable | Medium | Low to Medium — adoption friction, not a defect | The measured size is recorded in the first release and compared thereafter. Pruning platform-specific packages that macOS never loads is the first lever |
| The application is run from the DMG or a quarantined location | Medium | Low — update fails with a recoverable error | The failure is reported in the interface with a manual path, and the drag-to-install gesture is presented prominently in the DMG |
| Quitting during a long turn loses work | Medium | Medium — a user loses a turn they were waiting on | Quit drains the child before exiting and the session log is recovered on relaunch. Whether quit should warn during an active turn is left to Stage 5 |
| Workspace additions interact with repository gates | Medium | Low — contributor friction | New packages join the workspace definition and the existing configuration, path, and hygiene checks cover them rather than being excepted |
| An upstream sync conflicts with desktop changes | Medium, recurring | Low to Medium — a delayed sync or a hand-resolved merge | The design confines edits to three upstream files whose changes are additive list insertions, listed in [`desktop/README.md`](../../../README.md). A desktop package may not modify a harness package in place, so upstream behavior is never a merge site |
| An upstream sync changes a contract the desktop design depends on | Medium over time | High — boot failure or a silently wrong assumption | The three dependencies are named and cited in [`desktop/README.md`](../../../README.md): Loader internals, eager zstd persistence, and the eager `node-pty` import. A sync that touches any of them is a signal to re-run the packaged verification rather than only the unit tests |

## Risks carried by the repository rather than the application

Adding a desktop subtree changes the repository, and those consequences are recorded here rather than discovered at review time.

**The package count grows.** A shell, a bundle, and a closure manifest join the workspace, and the existing path, configuration, hygiene, and dependency-closure checks then cover them. The closure manifest in particular is the kind of dependency-only package the repository already has one of, and it should follow that precedent exactly rather than inventing a second shape.

**The non-trivial-change convention applies.** This work alters architecture, packaging, and process, so it requires an Agent Note in the same change, and the note must record the alternatives in this directory rather than restating the design.

**A platform-specific build enters CI.** The release workflow needs macOS runners and signing secrets. The repository's existing workflows build a single-file executable for macOS, so the runner shape is not new, but the secret surface is.

**The fork carries a divergence cost.** This repository takes upstream updates and does not contribute back, so every edit to an upstream-owned file is paid for again at each sync. The design answers this with a rule rather than a hope: desktop work adds files, and a desktop package never modifies a harness package in place. The three upstream files the work does touch are enumerated in [`desktop/README.md`](../../../README.md) with the reason each is unavoidable, so the list stays a decision instead of drifting upward.

## Open questions

These are recorded unresolved rather than answered with an assumption.

| Question | Consequence of each answer |
|---|---|
| Should quitting during an active turn warn? | A warning prevents lost work and adds a dialog to a frequent action |
| Is there a size ceiling that would force a different carrier? | A hard ceiling could favor dropping the second runtime earlier, or accepting a larger artifact for robustness |
| Which environment holds the signing secrets, and does publication require approval? | Approval protects the release from an accidental dispatch at the cost of a manual step |

The release origin, the monorepo placement, and the availability of signing credentials are resolved and recorded in [`plan.md`](plan.md).
