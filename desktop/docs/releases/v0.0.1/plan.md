# Plan

Status: Proposed

This document orders the work, states the exit criteria of each stage, and names what each stage produces. Stages are sequential because each one's exit criteria are the next one's preconditions.

## Stage 0 — Feasibility spike

The spike exists because three assumptions carry the whole design, and each is cheap to falsify but expensive to discover late. Its output is evidence recorded in this directory, not shippable code, and the spike code is discarded.

| Assumption | How the spike tests it | Result |
|---|---|---|
| Loader internals are reachable in an Electron child process | Launch the Electron binary with `ELECTRON_RUN_AS_NODE=1 --expose-internals`, require `internal/modules/esm/loader` through `createRequire`, and confirm `getOrInitializeCascadedLoader()` returns a loader, with the same require without the flag as the control | **Confirmed.** The flag resolves the loader; the control fails with `MODULE_NOT_FOUND` |
| The terminal addon loads under Electron | Load the repository's `node-pty` prebuild in the same child, open a PTY, and read a command's output back | **Confirmed, and simpler than expected.** The addon is N-API, so the stock-Node prebuild loads without recompilation and no rebuild stage exists |
| The frozen closure serves the interface | Deploy a closure, boot it from a directory, and request the interface and one client plugin bundle from the port it reports | **Confirmed, with a precondition.** The closure boots and serves the index with the boot manifest injected, each plugin bundle, and the static assets — but only after every workspace package is present, which a bare deploy does not produce |

The spike also established the version facts the rest of the work depends on, recorded with the measurements in [`architecture.md`](architecture.md): Electron 44.3.0 ships Node 24.20.0, which satisfies the repository engine floor of `^22.19.0 || >=24.0.0`, and that Node exposes `node:zlib` zstd and `node:sqlite`.

All three assumptions resolved in the direction that removes work rather than adding it. Neither the Loader's native helper nor an addon rebuild is part of the artifact, and the closure's boot path is confirmed.

**What the closure result means for Stage 1.** A bare `pnpm deploy` of the widest existing package produced a closure that deployed the frontend but could not boot: `link:` overrides left the two vendored framework packages out entirely, and peer dependencies were absent because the deploy ran with automatic peer installation disabled. Copying every built workspace package in made it boot, which isolates the remaining work as closure completeness rather than as a carrier or composition question.

That is not a new problem to solve. The existing executable build already answers it with a deploy-root manifest that lists every needed package as a direct dependency, and [`scripts/verify-runtime-closure.ts`](../../../../scripts/verify-runtime-closure.ts) fails the build when a workspace peer is missing. Stage 1 reuses both rather than inventing a second mechanism.

**Exit criteria.** Each of the three assumptions is confirmed or refuted with a recorded command and its output, and the carrier selection in [`architecture.md`](architecture.md) is either confirmed or revised.

## Stage 1 — The harness boots as a packaged child

The harness is booted from a frozen closure by an entry point that is not the command-line launcher, with no profile directory and no package manager involved.

Work:

- Add the closure manifest as a dependency-only package, following the existing deploy-root pattern.
- Add the desktop bundle: the patch layer over `@deepseek-ai/dsh-base`, the runtime glue that resolves the built frontend and mounts the static handler, and the structured readiness record.
- Add the packaged entry point that calls `boot()` with the closure as its bare-module base, deliberately not `runProfile`, and therefore without the fail-loud process handler and without the forced HMR mount.
- Disable the rows listed in [`architecture.md`](architecture.md) and redirect the persistence root under `DSH_HOME`.

**Exit criteria.** From a terminal on a development machine, the entry point boots the full composition from the closure directory, binds an ephemeral loopback port, serves the interface, and completes a turn against a scripted model. No profile directory is created and no package manager is invoked.

## Stage 2 — The shell

The Electron application owns the child's lifecycle and presents the interface.

Work:

- Main process: single-instance lock, child spawn, readiness read, window creation, child supervision, quit sequence with drain and forced termination on timeout.
- Preload: the minimal channel set for log forwarding and dialog invocation.
- Log capture: child standard output and standard error into a bounded buffer, forwarded to the window.
- Failure state: a window that reports a boot failure or an unexpected child exit with a restart action.
- Shell environment resolution per [`experience.md`](experience.md).

**Exit criteria.** Launching the shell opens a window showing the interface. Closing the window does not kill a running turn. Quitting terminates the child with no orphaned process and no bound port. Killing the child externally produces the failure state rather than a blank window, and restarting from that state recovers the conversation.

## Stage 3 — Packaging and signing

The first installable artifact.

Work:

- Account setup: export the Developer ID Application certificate as a `.p12` and create the App Store Connect API key, both per [`packaging.md`](packaging.md). This is independent of the build work and can be done in parallel with Stage 1.
- Bundle assembly: closure copy, configuration and preset roots, the addon rebuild, and the spawn-helper executable bit.
- `electron-builder` configuration: DMG and ZIP targets, the entitlements file, and the nesting rules that keep the closure out of `asar`.
- Signing, notarization, and stapling in the order given in [`packaging.md`](packaging.md).
- The packaging verification checks as a script, so they run identically in CI and locally.

**Exit criteria.** The DMG installs on a macOS machine with no Node.js, no package manager, and no repository checkout present. Gatekeeper accepts the application without an override. The signature verifies deeply and strictly, the notarization ticket validates, and the installed application passes every acceptance criterion in [`README.md`](README.md) except the update criteria.

**Result.** Met, less the clean-machine install. The packaged application is signed with the Developer ID identity, notarized, and stapled; `spctl --assess` reports `accepted` with `source=Notarized Developer ID`, and `stapler validate` passes. The packaged harness was started from inside the bundle and served the interface on a loopback port. Measurements are in [`packaging.md`](packaging.md).

This stage is the first point at which the release can be given to someone outside the project, because it is the first point at which a user needs no terminal.

## Stage 4 — Release and update

Work:

- The release workflow: every stage in [`distribution.md`](distribution.md), gated so a partially signed artifact is never published.
- Update feed: `electron-updater` against the release repository, with the check, download, prompt, and restart flow.
- About surface: desktop version, bundled harness version, and a manual check.
- Withholding procedure: converting a published release to a draft or prerelease, exercised once on a throwaway version.

**Exit criteria.** Publishing a higher version causes an installed application to offer it, and accepting restarts into the new version with the workspace and conversation history intact. Withholding that version causes an installed application to stop being offered it. An application whose signature has been altered is not offered an update.

The last criterion is checked deliberately, because a signature mismatch is silent otherwise and would surface as updates that never arrive.

## Stage 5 — Desktop integration and hardening

Work:

- The Electron-backed directory picker replacing the process-spawning provider for this composition only.
- The agent-error surface the runtime already records but no shipped component renders.
- Menu bar, About, and the log export path.
- Interface smoke coverage driven through the packaged application, using the browser-automation dependency the frontend package already carries.
- A first-run walkthrough against a clean macOS account, including the shell-environment resolution and the Gatekeeper interaction.

**Exit criteria.** A user who has never opened a terminal, starting from a clean macOS account, completes onboarding, selects a workspace, runs a turn that executes a shell command, approves an action, and quits and relaunches with history intact — with no step requiring a terminal and no failure visible only outside the interface.

## Companion deliverables

The repository's conventions apply to this work rather than being suspended for it.

| Deliverable | When |
|---|---|
| A proposed Agent Note recording the process model, the carrier selection, and the alternatives in this directory | Before Stage 1 |
| Moving that note to implemented, rewritten to describe what shipped | With Stage 3 |
| A package README for each new package, stating its contract, configuration, and limitations | With the package |
| Keyless snapshot coverage for the desktop composition: boot, the readiness record, and a first turn against a scripted model | With Stage 1 |
| An entry in the workspace definition for the new packages, so the existing configuration, path, and hygiene checks cover them | With Stage 1 |
| Recorded size and startup measurements for the first release, to compare later releases against | With Stage 3 |

The snapshot requirement is satisfied at the composition level rather than by automating the window, because the composition is what the harness change affects. Window behavior is covered by the interface smoke coverage in Stage 5, and the artifact-level gate is the clean-machine walkthrough.

## Resolved decisions

| Decision | Resolution |
|---|---|
| Release origin | This repository, `ceasarXuu/deepseek-harness-desktop`, which is public. It is a long-lived fork that never contributes upstream, so releases are published here rather than to the upstream release train |
| Where the shell and the new packages live | A workspace member of this repository, under `desktop/`, in keeping with the repository's monorepo shape |
| Distribution channel | Direct distribution as a signed DMG. The Mac App Store is not a target, which is consistent with the application not being sandboxed |
| Bundle identifier | `com.xuyutech.dsh.desktop`, recorded with its consequences in [`packaging.md`](packaging.md) |
| Signing certificate | `Developer ID Application: Xu Zhang (3BCJ5SAVU2)`, present in the build machine's login keychain |
| Minimum macOS version | Not a decision. It follows from the selected Electron line and is measured and recorded rather than chosen |

The consequence of publishing from a fork is that desktop tags use their own prefix and desktop releases have their own workflow; [`distribution.md`](distribution.md) records both. The upstream release workflows cannot publish here by accident, because their publish jobs are manual dispatches rather than push triggers.

## Open decisions

No decision blocks the start of work. The items below are deferred to the stage that needs them.

| Decision | Needed by | Options |
|---|---|---|
| Whether the minimum macOS version is acceptable | Stage 3 | Depends on the measured value. A lower floor would mean choosing an older Electron line at the cost of an older Chromium |

The release environment `desktop-release` is configured: it restricts deployments to tags matching `desktop-v*`, requires a reviewer before a deployment proceeds, and holds the five signing and notarization secrets. The notarization credential is validated against the notary service and stored under the keychain profile `dsh-notarization`; [`packaging.md`](packaging.md) records the values and what each secret receives.
