# Agent Note: Follow upstream's Desktop delivery and keep only the release identity

Status: implemented

English | [中文](2026-09-20-upstream-desktop-delivery-and-release-identity.zh.md)

The application is the [adopted upstream application](2026-09-13-adopt-upstream-desktop.md); where this fork publishes it is the [release destination](2026-09-13-desktop-release-destination.md).

## Problem

The fork's upstream sync to `0.1.6` landed as a wholesale take of upstream `master`. Upstream had replaced what this fork had patched around: the production dependency tree now travels inside `app.asar` instead of a loose `resources/dsh` tree, the loading surface is the Web application's own page instead of an Electron document, plugin management is a Web panel, and packaging reads its release settings from a target dotenv file that never falls back to the shell environment.

Every fork edit to an upstream-owned file was therefore resolved in upstream's favour, which left the tree consistent but not shippable: `finalize-macos-channel.ts` imported two symbols that no longer existed, the release workflow called a `finalize:mac:channel` script that no longer existed, and the fork's own modules — the runtime archive, MCP bundle installation, the diagnostics block — had no caller.

Re-applying the edits as they stood was the other option, and it had a cost that grew while it was considered: the archive existed because upstream shipped eleven thousand loose files in `Contents/Resources`, and upstream no longer does. Re-applying it would rebuild a mechanism whose premise upstream had removed, and would carry the load-bearing files it touches (`main.ts`, `prepare-dsh.ts`, the electron-builder resource mapping) as permanent conflicts at every future sync.

## Decision

The fork follows upstream's delivery and keeps only what it must own.

**Adopted from upstream.** The runtime travels as upstream packs it. The Electron documents this fork had extended are upstream's again, so the first-launch expansion, its progress surface, the recovery page, and the update flow are the shipped versions.

**Dropped, not carried forward.** `apps/desktop/src/runtime-closure.ts` and its tests; `apps/desktop/src/mcp-bundles.ts`, its tests and its fixtures; `apps/desktop/src/diagnostics.ts` and its tests. Two of those surfaces had already lost their home — upstream deleted `renderer/plugin-manager.*` and `renderer/startup.*`, which is where the fork had mounted them — so carrying them would have meant rebuilding them against upstream's Web UI rather than shipping them. The dormant `desktop/packages/plugin-store` and `desktop/packages/ui-plugin-store` go with them, since the capability they recorded is no longer expressed anywhere in this repository.

**Kept, because the fork still owns it.** The release destination: a GitHub release in `ceasarXuu/deepseek-harness-desktop`, an `app-update.yml` naming that repository and release type, a validated upload of the DMG, ZIP, and blockmap, and a finalize step that merges both architectures' ZIPs into one `<channel>-mac.yml` because one release carries one channel file. Upstream publishes to Tencent COS with credentials this fork does not hold, so this is the one difference that cannot be dropped. The macOS certificate is still accepted as a full common name, because this keychain holds two certificates that share a short name. The dark application icon stays named by the packaging configuration; upstream now ships its own icons, so this is a brand choice rather than a gap being filled.

**Moved into the release workflow.** Release settings reach packaging through `apps/desktop/.env.macos`, which the workflow writes from its secrets before packaging. The workflow no longer imports the signing certificate into a keychain of its own: the packaging command creates a temporary one from `CSC_LINK` and removes it when the run ends.

## Alternatives considered

- **Re-apply the runtime archive onto upstream 0.1.6.** Rejected: upstream packs the tree into `app.asar`, so the eleven-thousand-loose-file premise is gone, and the re-application would touch the files upstream changes most.
- **Keep the fork's own surfaces and re-express them on upstream's Web UI.** Rejected for this change, not on merit: it needs a client package, IPC, a preload bridge, and two locale dictionaries before anything is visible, and the release does not depend on it. The decisions those surfaces recorded stay archived and remain available if the capability is wanted again.
- **Publish to upstream's Tencent COS destination.** Rejected: it needs credentials this fork does not hold, and the origin serves upstream's builds.
- **Keep the fork's `app-update.yml` writer beside upstream's.** Rejected: two modules writing one file means one of them silently stops being the owner. Upstream's `macos-app-update-config.mjs` owns it and now writes the GitHub provider.

## Consequences

The fork's patch surface inside `apps/desktop` is the release identity alone, so the next sync resolves fewer conflicts. An application installed from an earlier fork release keeps updating: the channel filename still comes from the version's prerelease component, so `0.1.5-rc.3` still reads `rc-mac.yml`, which the fork still publishes.

Removed capabilities are recoverable from the commit that dropped them rather than re-expressed here. The fork no longer installs `.mcpb` bundles from its own window, no longer shows a diagnostics block, and no longer expands a verified runtime on first launch.
