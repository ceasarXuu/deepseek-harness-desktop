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
| `node-addon-require-builtin` is avoidable | **Verified on a running Electron child** | With `--expose-internals`, `internal/modules/esm/loader` resolves and `getOrInitializeCascadedLoader()` returns a loader; without it the same require fails with `MODULE_NOT_FOUND` |
| The terminal addon loads under Electron | **Verified on a running Electron child** | The repository's `node-pty` prebuild — compiled for stock Node — loaded, opened a PTY, and returned the command's output, because the addon is N-API |
| Electron's bundled Node satisfies the engine floor | **Verified from a running Electron child** | Electron 44.3.0 reports Node 24.20.0, with `node:zlib` zstd and `node:sqlite` both present |
| The frozen closure serves the interface | **Verified on a running closure** | A deployed closure booted, reported a loopback port, and served the index with the boot manifest injected, a 52 kB plugin bundle, and the static assets. Boot requires every workspace package present, which the deploy-root manifest and `verify-runtime-closure` already enforce |
| A bare `pnpm deploy` produces a bootable closure | **Refuted** | `link:` overrides omit the vendored framework packages and disabled automatic peer installation omits peers; the spike restored both by hand to reach a boot |

## Risk register

Likelihood and impact are recorded so the ordering of mitigation is deliberate rather than incidental.

| Risk | Likelihood | Impact | Mitigation or fallback |
|---|---|---|---|
| The frozen closure fails to serve the interface | Low | High — invalidates the composition | Stage 0 tests it. This is the only failure whose repair touches the composition rather than the carrier |
| A nested binary is rejected by notarization | Medium | Medium — blocks publication until the offending file is fixed | Notarization reports the offending file and reason, so the repair is localized to one artifact's signing or entitlements. A release candidate is notarized before the release is tagged, so the round trip happens off the critical path |
| The signing certificate is replaced with one from another team | Low | High — installed applications stop accepting updates | The team identifier is recorded in [`packaging.md`](packaging.md) and the updater compares it. Renewal keeps the same team, which is why the expiry below is a deadline rather than a migration |
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
