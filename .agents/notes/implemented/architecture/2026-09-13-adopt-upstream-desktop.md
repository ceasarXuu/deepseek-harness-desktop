# Agent Note: Adopt the upstream Desktop application

Status: implemented

English | [中文](2026-09-13-adopt-upstream-desktop.zh.md)

The delivery format this fork keeps is the [runtime archive](2026-09-13-desktop-runtime-archive.md); the destination it publishes to is the [release destination](2026-09-13-desktop-release-destination.md).

## Problem

A desktop distribution needs the harness to run on a machine with no Node.js, no package manager, and no terminal, while the shipped harness assumes the opposite: [`apps/cli`](../../../../apps/cli/README.md) resolves bundles from a profile directory, mounts plugins by bare name through Node's module resolver, installs a process-exiting handler, and force-mounts an interactive HMR service. Running the harness inside the Electron main process cannot work either — the terminal capability imports `node-pty` eagerly, bare-specifier resolution needs Node's internal ESM loader, and the launcher's failure handler would terminate the application on one unhandled rejection.

This fork answered that with its own application: an Electron-as-Node shell, a desktop bundle package, and a closure the shell repaired after every deploy. Meanwhile upstream built `apps/desktop` and `apps/desktop-host`. Two implementations of the same product diverge in every dimension that matters — the profile format, the plugin transaction model, the recovery UX, the update unit, and the parts of the harness each one assumes — and each side's fixes land only on its own side.

## Decision

The desktop application in this repository is upstream's: `apps/desktop` (Electron shell) and `apps/desktop-host` (private Host process), with their composition, profile, plugin transactions, recovery actions, and update unit unchanged. The fork's shell (`desktop/apps/shell`), its bundle package (`desktop/packages/bundle-desktop-app`), its closure root (`desktop/runtime-closure`), and the two build drivers that produced them (`desktop/build/package-app.mjs`, `desktop/build/build-closure.mjs`) are deleted.

This note consolidates the composition note (`2026-09-12-desktop-application-composition.md`, deleted with this change), which recorded the deleted implementation.

What survives from the fork's own work is everything independent of the application's internals:

- **Runtime delivery.** The production dependency tree travels as one verified archive that the first launch expands under `$DSH_HOME/closure/<version>` ([archive decision](2026-09-13-desktop-runtime-archive.md)). Upstream carries the tree as loose bundle resources.
- **Release identity.** The bundle identifier, signing identity, notarization credentials, and the release repository are this fork's ([release destination](2026-09-13-desktop-release-destination.md)). Upstream publishes to its own origin, credentials, and bundle identifier.
- **Dormant plugin work.** `desktop/packages/plugin-store` and `desktop/packages/ui-plugin-store` stay in the tree but outside the workspace, so they neither build nor run. Upstream's plugin manager window over the bundled pnpm expresses the same capability today; the MCP package surface those packages carried is not re-expressed yet.
- **Assets.** `desktop/build/icons` and `desktop/build/entitlements.mac.plist` stay. Upstream's packaging uses Electron's default icon, so adopting the icons is a product change with its own verification rather than part of this decision.

## Patch surface

Every fork change inside `apps/desktop` is a merge conflict at the next upstream sync, so the surface is enumerated in [desktop/README.md](../../../../desktop/README.md) and kept as small as the delivery difference allows. The patches are of two kinds: the delivery itself (the archive module and tests, the startup wiring that expands it with progress, the packaging steps that produce and carry it) and the release identity (the signing-identity patch that accepts a full certificate common name, the payload smoke's removed `fs-ext` check, and the release destination).

Upstream-owned Agent Notes are left alone, including the [packaging and updates note](2026-08-25-electron-desktop-packaging-and-updates.md) whose release destination this fork changes; the fork's own notes state where its behavior differs.

## Alternatives considered

- **Keep the fork's application and take upstream's packages selectively.** Rejected: the applications model the profile, the plugin lifecycle, and the update unit differently, so a partial adoption maintains a third design matching neither.
- **Keep both applications and let users choose.** Rejected: two signed applications with the same bundle identifier and the same `$DSH_HOME` ownership cannot coexist, and a second install path doubles the release work for no user-visible capability.
- **Vendor upstream's application as a pinned copy.** Rejected: this fork already fetches upstream `master` for the rest of the tree, so a vendored copy of one subtree would need its own sync procedure and would still conflict wherever the delivery patches apply.
- **Contribute the archive layer upstream and carry no patches.** Rejected for now, not on merit: upstream has no desktop CI, so a packaging change cannot be validated there, and this fork needs the delivery now. The patch surface is narrow enough to become an upstream proposal later.
- **Run the harness in the Electron main process.** Rejected with the fork's application, and unavailable to upstream for the same three reasons in the Problem; it would also let a harness crash take the application with it.
- **Ship the `pkg --sea` single-file executable the SDK runtime uses.** Rejected as the carrier: it puts a virtual filesystem between the harness and its own package tree, moving client-bundle reads, `createRequire` resolution, and worker entry paths behind archive semantics. It remains the documented fallback in [`desktop/docs/releases/v0.0.1/architecture.md`](../../../../desktop/docs/releases/v0.0.1/architecture.md).
- **Let the shell decide readiness by polling.** Rejected: the harness is the only party that knows when its tree has settled, which is why the private Host reports a structured readiness record instead. A shell that guessed would open the window against a half-mounted composition.

## Consequences

The fork tracks upstream's application and inherits its profile format, plugin transactions, and recovery UX, including the parts still marked pre-release. Application updates follow upstream's cadence while the delivery format and release destination stay the fork's.

The fork's own application code is gone, together with the tests that pinned it. The constraints its design established still hold and are now upstream's to keep: the harness never runs in Electron's main process, a packaged application carries a real dependency tree rather than an archive it reads through, and the window opens only after a readiness handshake rather than on a timer.

The delivery difference costs a first-launch expansion upstream does not have, and the release difference costs a release workflow upstream does not have. The archive decision's acceptance measures the first; the [release destination](2026-09-13-desktop-release-destination.md) owns the second.
