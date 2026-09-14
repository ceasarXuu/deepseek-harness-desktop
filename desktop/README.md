# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop distribution of DeepSeek Harness: a signed, self-contained macOS application that runs the harness and its browser interface without a terminal, a system Node.js, or any separately started service.

The application itself is upstream's — `apps/desktop` (Electron shell) and `apps/desktop-host` (private Host process). This subtree records what this fork changes around it, what it keeps from its own earlier implementation, and how a release is made. The [adoption decision](../.agents/notes/implemented/architecture/2026-09-13-adopt-upstream-desktop.md) owns why.

## Relationship to the harness

The shell boots a private Host process from the runtime the application carries, and that process mounts the same plugin tree `dsh --profile web` mounts. Three harness facts shape every design decision here, and each is owned by the package that states it rather than by this subtree:

- Bare-specifier plugin resolution requires the Loader's `internal` module access ([`vendor/loader/src/internal.ts`](../vendor/loader/src/internal.ts)).
- The default persistence backend eagerly imports `node:zlib` zstd, and the session-search index imports `node:sqlite` ([`packages/session/session-persistence-jsonl`](../packages/session/session-persistence-jsonl/README.md)).
- The terminal capability eagerly loads the `node-pty` native addon ([`packages/subprocess/subprocess-local`](../packages/subprocess/subprocess-local/README.md)).

## Development model

This repository is a long-lived fork of `deepseek-ai/deepseek-harness`. Development happens here; upstream `master` is fetched only to take updates. Nothing developed for the desktop application is contributed back.

That arrangement makes one property load-bearing: **the cost of pulling upstream is proportional to how many upstream-owned files this fork edits.** Every edited upstream file is a merge conflict at the next sync, so desktop work adds new files by preference and modifies existing ones only where the delivery or the release identity requires it.

### Upstream-owned files this fork edits

Adding an entry to this table is a decision, not a side effect.

| File | Edit | Why it cannot be avoided |
|---|---|---|
| [`apps/desktop/src/runtime-closure.ts`](../apps/desktop/src/runtime-closure.ts), [`apps/desktop/tests/runtime-closure.spec.ts`](../apps/desktop/tests/runtime-closure.spec.ts) | New module and tests: pack, digest, expand, and heal the runtime archive | This is the delivery format; upstream carries the tree as loose resources |
| [`apps/desktop/src/main.ts`](../apps/desktop/src/main.ts) | Expand the archive into `$DSH_HOME/closure/<version>` before the backend starts, reporting progress | The runtime location upstream assumes is `resources/dsh`, which this fork does not ship |
| [`apps/desktop/src/paths.ts`](../apps/desktop/src/paths.ts) | Add the closure root | The expansion directory is an Electron-owned path |
| [`apps/desktop/src/backend-controller.ts`](../apps/desktop/src/backend-controller.ts) | Carry expansion progress in the `starting` backend state | The loading window renders it |
| [`apps/desktop/renderer/startup.html`](../apps/desktop/renderer/startup.html), [`startup.js`](../apps/desktop/renderer/startup.js), [`startup.css`](../apps/desktop/renderer/startup.css), [`src/locale.ts`](../apps/desktop/src/locale.ts) | A determinate progress bar and its English and Chinese copy | The first launch expands eleven thousand files; an unlabelled spinner reads as a hang |
| [`apps/desktop/scripts/prepare-dsh.ts`](../apps/desktop/scripts/prepare-dsh.ts) | Pack the verified tree and prove the archive expands back to it | The build must fail when what it packed is not what it verified |
| [`apps/desktop/scripts/desktop-build-paths.mjs`](../apps/desktop/scripts/desktop-build-paths.mjs) (+ [`.d.mts`](../apps/desktop/scripts/desktop-build-paths.d.mts)) | Add the archive and digest paths | Each target owns its own archive |
| [`apps/desktop/electron-builder.config.mjs`](../apps/desktop/electron-builder.config.mjs) (+ [`.d.mts`](../apps/desktop/electron-builder.config.d.mts)) | Carry the archive and its digest instead of the tree, verify them in `afterPack`/`afterSign`, and publish with the `github` provider | Resource mapping, build-time verification, and the release destination are configured here |
| [`apps/desktop/scripts/desktop-auto-update-environment.mjs`](../apps/desktop/scripts/desktop-auto-update-environment.mjs) (+ [`.d.mts`](../apps/desktop/scripts/desktop-auto-update-environment.d.mts)) | Resolve a GitHub repository, release tag, and release type instead of a Tencent COS origin and bucket | This fork publishes to its own repository |
| [`apps/desktop/scripts/desktop-upload-plan.ts`](../apps/desktop/scripts/desktop-upload-plan.ts), [`apps/desktop/scripts/upload-target.ts`](../apps/desktop/scripts/upload-target.ts) | Validate the same artifacts and upload them as GitHub release assets | The validated upload is the point; only the transport changes |
| [`apps/desktop/src/desktop-update-metadata.ts`](../apps/desktop/src/desktop-update-metadata.ts), [`apps/desktop/tests/desktop-update-metadata.spec.ts`](../apps/desktop/tests/desktop-update-metadata.spec.ts) | New module and tests: write `app-update.yml` and the channel metadata | electron-builder writes them only in a pass that builds an installer target, and this application builds its installers from an already packaged directory |
| [`apps/desktop/scripts/package-target.ts`](../apps/desktop/scripts/package-target.ts) | Record the tag and release type, and withhold `GH_TOKEN`/`GITHUB_TOKEN` from packaging subprocesses | The upload needs a record it can trust, and packaging needs no credential |
| [`apps/desktop/scripts/desktop-release-environment.mjs`](../apps/desktop/scripts/desktop-release-environment.mjs) (+ [`.d.mts`](../apps/desktop/scripts/desktop-release-environment.d.mts)), [`verify-macos-signature.mjs`](../apps/desktop/scripts/verify-macos-signature.mjs), [`tests/macos-signature.spec.ts`](../apps/desktop/tests/macos-signature.spec.ts) | Accept a full certificate common name and derive the short one from it | Two certificates in this keychain share a short name, so name matching is ambiguous |
| [`apps/desktop/tests/fixtures/runtime-payload-smoke.mjs`](../apps/desktop/tests/fixtures/runtime-payload-smoke.mjs) | Drop the `fs-ext` check | `@deepseek-ai/node-addon-system` replaced that dependency, so the file is absent from the closure |
| [`apps/desktop/tests/main-startup.spec.ts`](../apps/desktop/tests/main-startup.spec.ts), [`startup-renderer.spec.ts`](../apps/desktop/tests/startup-renderer.spec.ts), [`macos-signature.spec.ts`](../apps/desktop/tests/macos-signature.spec.ts), [`desktop-build-paths.spec.ts`](../apps/desktop/tests/desktop-build-paths.spec.ts), [`desktop-auto-update-environment.spec.ts`](../apps/desktop/tests/desktop-auto-update-environment.spec.ts), [`desktop-upload-plan.spec.ts`](../apps/desktop/tests/desktop-upload-plan.spec.ts), [`package-target.spec.ts`](../apps/desktop/tests/package-target.spec.ts) | Track the behavior above | Tests describe the behavior this fork ships |
| [`packages/fs/tool-fs-search/src/search-core.ts`](../packages/fs/tool-fs-search/src/search-core.ts), [`packages/fs/tool-fs-search/tests/rg-unpacked.spec.ts`](../packages/fs/tool-fs-search/tests/rg-unpacked.spec.ts), [`patches/node-pty@1.2.0-beta.15.patch`](../patches/node-pty@1.2.0-beta.15.patch), [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | Unwrap a binary path inside an `<name>.asar`, and patch node-pty's loader to read `DSH_NODE_PTY_SPAWN_HELPER` | Both solved one problem for the deleted shell: a launched path must be a real file. The adopted application expands its runtime to a real directory, so neither lever fires today; they stay listed because they remain fork patches to upstream-owned files |

Everything else this subtree needs is its own file: the release workflow, the Agent Notes, the historical release documentation, and this README.

The rule that keeps the table short is that a fork change belongs in `apps/desktop` only where the delivery or the release identity requires it, and never in a harness package unless the platform itself demands it.

## Dormant assets

| Path | State | Why it is kept |
|---|---|---|
| [`packages/plugin-store`](packages/plugin-store), [`packages/ui-plugin-store`](packages/ui-plugin-store) | Outside the workspace: neither builds nor runs | The capability they carried now ships as [`apps/desktop/src/mcp-bundles.ts`](../apps/desktop/src/mcp-bundles.ts) (install, registry, generated plugin) and the plugin window's MCP bundles section; the two packages remain only as the earlier implementation |
| [`build/icons`](build/icons), [`build/entitlements.mac.plist`](build/entitlements.mac.plist) | Unused by the current packaging | Upstream's configuration uses Electron's default icon, so adopting these icons is a product change with its own verification |
| [`docs/releases`](docs/releases/README.md) | Historical release plans | They record what each version intended |

## Tags and releases

A release is tagged `v<version>` and published as a GitHub release in `ceasarXuu/deepseek-harness-desktop` by [the release workflow](../.github/workflows/desktop-release.yml). The tag is the version itself because the updater's GitHub provider compares release tags as semantic versions and derives the prerelease channel from the version's prerelease component. The `dsh-v*` prefix belongs to the upstream release train, whose tags arrive with every upstream fetch, so it cannot be shared. The [release destination decision](../.agents/notes/implemented/architecture/2026-09-13-desktop-release-destination.md) owns the feed, the credentials, and the upload validation.

## Pre-release stance

The repository's pre-release stance applies with full force here: with no external consumers of this fork, the correct foundation is preferred over compatibility shims, and on-disk formats may be revised rather than migrated. This is why the runtime archive carries no migration path for the format it is the first to write.

## Local toolchain

Running any `pnpm run check:ci:*` aggregate requires a pnpm that is a JavaScript entry point reporting the version pinned by `packageManager` in `package.json`.

Two harness details create that requirement. `scripts/run-gates.ts` spawns every gate as `node <npm_execpath> ...`, which only works when `npm_execpath` names a JavaScript file. Separately, several package scripts invoke `pnpm` again by name, and that nested process enforces the `packageManager` field.

A standalone pnpm binary — the `@pnpm/exe` distribution that a version manager such as mise installs — satisfies neither. It fails the first requirement with `SyntaxError: Invalid or unexpected token` for every gate in the aggregate, and the second with a version-mismatch error. The failures name individual gates, so the shared cause is not obvious from the output.

The remedy is to place a JavaScript pnpm at the pinned version ahead of the binary on `PATH`, for example a shim that execs `node apps/desktop/node_modules/pnpm/bin/pnpm.cjs "$@"`. CI satisfies this by construction, because `pnpm/action-setup` installs pnpm at the version `package.json` pins.

## Building locally

Three levels of cost, for three kinds of change.

**Run from the source tree.** The shell and the harness both run from what the workspace built, so interface work needs no packaging:

```sh
pnpm run dev:desktop
```

Development Harness state defaults to `apps/desktop/.desktop-build/development/home`; the [app README](../apps/desktop/README.md) owns the overrides.

**Install a development build.** `--dir` stops after the assembled application, so there is no installer to compress and no notarization round trip:

```sh
pnpm run package:desktop:mac:arm64:dir
ditto "apps/desktop/.desktop-build/targets/mac-arm64/artifacts/mac-arm64/DeepSeek Harness.app" "/Applications/DeepSeek Harness.app"
```

Use this to check what the packaged application actually does — the first-launch expansion, Resources paths, crash handling — none of which the source-tree run reproduces. Updates are not testable here: the updater reads the release feed, and a `--dir` build carries no installer to update from.

**Build the deliverable.** The release commands produce the signed and notarized DMG and ZIP, and the upload publishes them:

```sh
pnpm run package:desktop:mac:arm64   # or package:desktop:mac:x64
GH_TOKEN=$(gh auth token) pnpm run upload:mac:arm64
```

Every package command runs the official build, packs the first-party production closures, prepares the target Node.js and pnpm runtime, materializes and verifies the dsh tree, packs it into `desktop-runtime.tar.zst` with its digest, and expands that archive to prove it reproduces the tree. The application resources carry the archive, its digest, and the Node.js and pnpm runtime.

The signing and notarization environment, the update destination, and the upload credentials are documented in the [app README](../apps/desktop/README.md).

## Releases

| Version | Status | Target | Docs |
|---|---|---|---|
| 0.0.1 | Proposed | macOS (Apple Silicon) | [`docs/releases/v0.0.1`](docs/releases/v0.0.1/README.md) |
| 0.0.2 | Proposed | macOS (Apple Silicon) | [`docs/releases/v0.0.2`](docs/releases/v0.0.2/README.md) |
| 0.0.4 | Proposed | macOS (Apple Silicon, Intel) | [`docs/releases/v0.0.4`](docs/releases/v0.0.4/README.md) |
