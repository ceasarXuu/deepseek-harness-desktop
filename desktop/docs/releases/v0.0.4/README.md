# Desktop v0.0.4

English | [中文](README.zh.md)

Status: Proposed

The first desktop release built on upstream's desktop application. The application is upstream's; this version adds the fork's runtime delivery and its own release destination.

## What this version must make true

- The installer carries the production dependency tree as one verified archive — two resources instead of eleven thousand loose files — and the first launch expands it under `$DSH_HOME/closure/<version>` with determinate progress on the loading page.
- A runtime file that is changed, removed, or added after the first launch is detected on the next launch, and the tree is expanded again from the verified archive instead of being trusted.
- A release is published as a `v<version>` GitHub release in this repository, and an installed application finds it: a prerelease build reads its own `<channel>-mac.yml`, a stable build reads `latest-mac.yml`.
- The signed DMG passes Gatekeeper and carries a stapled notarization ticket; the application inside it is accepted as notarized.
- The application runs the harness from the expanded tree with upstream's profile, plugin transactions, and recovery actions unchanged.

## What this version excludes

| Excluded | Why, and where it is reconsidered |
|---|---|
| A Windows release | Signing needs a SafeNet token attached to a self-hosted runner. CI builds an unsigned installer as a workflow artifact and does not touch the release |
| The fork's application icons | Adopting them changes the bundle and must be verified like any other artifact change; upstream ships Electron's default icon today |
| Installing plugin bundles while the application runs | Upstream's plugin manager window over the bundled pnpm covers the capability; the dormant `plugin-store` packages stay out of the workspace until the MCP package surface is re-expressed there |
| Migrating an earlier desktop installation | No desktop release has shipped, so the archive format has no readers to migrate |

## Scope of change

| Area | Change | Owner |
|---|---|---|
| Delivery | The runtime archive: pack, digest, expand, heal, and report progress | `apps/desktop/src/runtime-closure.ts`, `apps/desktop/src/main.ts`, `apps/desktop/scripts/prepare-dsh.ts`, `apps/desktop/electron-builder.config.mjs` |
| Release | GitHub Releases destination, validated upload, release workflow | `apps/desktop/scripts/desktop-auto-update-environment.mjs`, `apps/desktop/scripts/upload-target.ts`, `.github/workflows/desktop-release.yml` |
| Application | Adopted from upstream, unmodified apart from the delivery and release patches | `apps/desktop`, `apps/desktop-host` |
| Removed | The fork's shell, bundle package, closure root, and their build drivers | — |

## How completion is observed

1. `pnpm run package:desktop:mac:arm64` on an Apple Silicon host produces the DMG, the ZIP, its blockmap, and `rc-mac.yml` for a prerelease version.
2. The DMG passes `spctl --assess --type open` and `xcrun stapler validate`; the application inside it passes `codesign --verify --deep --strict` and Gatekeeper.
3. The first launch shows the loading page with a determinate bar, then opens the workspace; the closure directory holds 11,226 files and one `.complete` marker.
4. Changing a file under the closure makes the next launch expand the archive again: the changed file returns to its recorded content and an added file disappears.
5. `GH_TOKEN=… pnpm run upload:mac:arm64` creates the release when the tag has none, uploads the artifacts, and uploads the channel metadata last.
