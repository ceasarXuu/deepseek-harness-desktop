# Agent Note: Ship the Desktop runtime as one verified archive

Status: implemented

English | [中文](2026-09-13-desktop-runtime-archive.zh.md)

Package ownership, shared links, and profile transactions follow the [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md).

## Problem

The production dependency graph is eleven thousand files. Carried as loose resources inside the signed bundle, every one of them is a file the installer writes on the user's machine, a block a release diff must move, and an entry no affordable startup check covers. The bundle signature fixes what those bytes are at build time and says nothing about the tree on disk afterwards, so damage or tampering is neither detected nor repaired: unusable modules fail when they load.

The amount of installation work is a product decision here, not only a size: the desktop application's reason to bundle its runtime at all is that the user installs once and starts without a package installation.

## Decision

`prepare:dsh` packs the prepared runtime tree into `desktop-runtime.tar.zst` and writes `desktop-runtime.tar.zst.sha256` beside it, holding the archive's sha256 and its entry count. electron-builder copies those two files as the runtime resources; the production tree itself never enters the application bundle. `extraResources` keeps the prepared Node.js and pnpm runtime as loose files because Electron and the expansion both run them directly from `process.resourcesPath`.

The first launch verifies the archive against the recorded digest, expands it into `$DSH_HOME/closure/<version>`, restores the executable bit on the binaries whose mode the expansion lost, and records the archive digest, its byte count, the entry count, and the expanded tree's digest in `.complete`. Every later launch digests the tree and compares it with that record. An unreadable marker, a changed, missing, or added file expands the archive again from the verified bytes; the application repairs its runtime instead of starting from a tree nobody vouched for.

`$DSH_HOME/closure/<version>` is now the runtime location the Host starts from and the one profile shared links resolve into; `resources/dsh` no longer exists. The version key is the release version, so a Desktop update lands in a new directory and the previous one is pruned. The loading page reports determinate progress while the archive expands, and the digest pass that precedes it reports an indeterminate stage.

## Integrity model

Two digests, each guarding what the other cannot.

- **The archive digest** is the reference the signed bundle carries. `afterPack` and `afterSign` recheck it inside the application resources and inside the signed application, so a copy that dropped or changed the archive fails the build; the first launch rechecks it before expanding anything, so bytes that no longer match refuse to expand at all — the failure names reinstallation rather than starting a partially trusted runtime.
- **The tree digest** describes the expansion. Hashing every file in sorted path order makes the result depend on paths and contents and not on read order, so an expansion can be compared against the digest recorded when it was written. This is the half that detects a tree modified after the first launch and covers the case the archive digest alone cannot: an extraction that was interrupted, or files changed in place afterwards.

Expansion is staged in a `.tmp-<pid>-<time>` sibling and renamed into place only after the tree digest is recorded, so an interrupted attempt leaves nothing a later launch could accept as a runtime. A build-time round trip in `prepare:dsh` expands the archive it just wrote into a temporary home and compares that tree's digest with the packed tree's, which is what makes packaging fail when the archive it produced is not the tree it verified.

The per-file `desktop-runtime.json` descriptor stays inside the archive. It still names shared packages, the release identity, and the recorded inventory; startup reads it for shared package records and the runtime identity, while integrity comes from the two digests above.

## Alternatives considered

- **Keep the loose tree inside the bundle (the upstream layout).** This is what the installer and update blocks paid for eleven thousand times, and it leaves the installed tree outside every check the application can afford. Its one advantage — the tree's files are individually sealed by the bundle signature — is preserved by digesting the archive the signature covers.
- **Ship the tree inside the ASAR.** The backend runs upstream Node.js rather than Electron's patched filesystem, so ASAR paths are unavailable to it, and native modules and spawned executables need real files. The archive expands into an ordinary directory for exactly that reason.
- **Expand every launch into a temporary directory.** This removes the stale-tree problem at the cost of an extraction in every start path, including updates and recovery, and it discards the plugin-compatible real directory the profile links resolve against. The recorded tree digest keeps the startup check honest without paying the expansion.
- **Verify the expanded tree on every launch with the descriptor's per-file inventory instead of one tree digest.** This is the verification the release-validation decision assigns to packaging; reading eleven thousand small files before the backend starts costs far more than digesting the same bytes sequentially, and it still would not make the check self-healing.
- **Trust the bundle signature only.** Nothing repairs a damaged or modified tree, so a single changed byte becomes a reinstall. Healing is the reason the archive travels instead of the tree.

## Consequences

Installation writes two resources instead of eleven thousand files, and the expanded tree appears once under the Harness home on first launch. A user or process that changes, removes, or adds a runtime file gets a fresh expansion on the next launch rather than a diagnosis, so runtime integrity does not surface as a load failure inside the backend.

The cost is paid at startup and at update time. The archive digest and the tree digest both run before the backend starts, and the expansion appears in first-launch latency — the release qualification measures it. A Desktop update also repeats the expansion for the new version, which the version-keyed directory makes explicit rather than hiding in an installer. On the reference Apple Silicon build, the archive is 29 MB for a 146 MB tree of 11,226 files; the first launch expands it in about 2.5 s, a later launch digests the expanded tree in about 0.4 s, and a damaged tree is restored in about 10 s including the fresh expansion.

This fork carries the archive layer as patches to upstream-owned desktop files: the archive module and its tests are new files, while `prepare-dsh.ts`, `electron-builder.config.mjs`, `desktop-build-paths.mjs`, `main.ts`, `paths.ts`, `backend-controller.ts`, the startup renderer, and the locale copy are edited. [desktop/README.md](../../../../desktop/README.md) owns the patch inventory for upstream syncs.

The [Desktop README](../../../../apps/desktop/README.md) owns operational guidance. [Closure tests](../../../../apps/desktop/tests/runtime-closure.spec.ts) pin the two digests, the executable-bit restore, the pruning of other versions, and what a modified, missing, extra, or unreadable file does; [startup tests](../../../../apps/desktop/tests/main-startup.spec.ts) pin that the expansion runs before the Host and that its failure leaves the recovery document in place. Expansion latency, installer size, and the notarized installer's own acceptance remain release-environment measurements.
