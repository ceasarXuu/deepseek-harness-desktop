# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop distribution of DeepSeek Harness: a signed, self-contained macOS application that runs the harness and its browser interface without a terminal, a system Node.js, or any separately started service.

The application is upstream's — `apps/desktop` (Electron shell) and `apps/desktop-host` (private Host process), with their composition, runtime layout, profile handling, plugin transactions, recovery actions, and update unit unchanged. This subtree owns where a release comes from: the GitHub release this fork publishes and the identity it is signed with. The [release destination decision](../.agents/notes/implemented/architecture/2026-09-13-desktop-release-destination.md) owns why.

## Relationship to the harness

The shell boots a private Host process from the runtime the application carries, and that process mounts the same plugin tree `dsh --profile web` mounts. Three harness facts shape every design decision here, and each is owned by the package that states it rather than by this subtree:

- Bare-specifier plugin resolution requires the Loader's `internal` module access ([`vendor/loader/src/internal.ts`](../vendor/loader/src/internal.ts)).
- The default persistence backend eagerly imports `node:zlib` zstd, and the session-search index imports `node:sqlite` ([`packages/session/session-persistence-jsonl`](../packages/session/session-persistence-jsonl/README.md)).
- The terminal capability eagerly loads the `node-pty` native addon ([`packages/subprocess/subprocess-local`](../packages/subprocess/subprocess-local/README.md)).

## Development model

This repository is a long-lived fork of `deepseek-ai/deepseek-harness`. Development happens here; upstream `master` is fetched only to take updates. Nothing developed for the desktop application is contributed back.

That arrangement makes one property load-bearing: **the cost of pulling upstream is proportional to how many upstream-owned files this fork edits.** Every edited upstream file is a merge conflict at the next sync, so desktop work adds new files by preference and modifies existing ones only where the release identity requires it. When upstream changes the delivery or the packaging path in a way that makes a fork edit unnecessary, the edit is dropped rather than carried forward.

### Upstream-owned files this fork edits

Adding an entry to this table is a decision, not a side effect. Upstream's own [`apps/desktop/README.md`](../apps/desktop/README.md) documents the Tencent COS destination these edits replace; the packaging stages themselves are unchanged.

| File | Edit | Why it cannot be avoided |
|---|---|---|
| [`apps/desktop/scripts/desktop-auto-update-environment.mjs`](../apps/desktop/scripts/desktop-auto-update-environment.mjs) (+ [`.d.mts`](../apps/desktop/scripts/desktop-auto-update-environment.d.mts)) | Resolve a GitHub repository, release tag, and release type instead of a Tencent COS origin and bucket; derive the channel metadata filename from the version's prerelease component | This fork publishes to its own repository, and the updater's GitHub provider derives its channel from the version |
| [`apps/desktop/scripts/desktop-package-environment.mjs`](../apps/desktop/scripts/desktop-package-environment.mjs) | Accept `DSH_DESKTOP_UPDATE_REPOSITORY` as a release setting | The test deployment names the repository it publishes to |
| [`apps/desktop/scripts/desktop-upload-plan.ts`](../apps/desktop/scripts/desktop-upload-plan.ts), [`apps/desktop/scripts/upload-target.ts`](../apps/desktop/scripts/upload-target.ts) | Validate the same completion record, channel metadata, sizes, and digests, then upload GitHub release assets; a macOS lane uploads no channel metadata | The validated upload is the point; only the transport changes, and one release carries one merged macOS channel file |
| [`apps/desktop/scripts/macos-app-update-config.mjs`](../apps/desktop/scripts/macos-app-update-config.mjs) (+ [`.d.mts`](../apps/desktop/scripts/macos-app-update-config.d.mts)) | Write and verify a `github` provider `app-update.yml` instead of a fixed generic feed | The packaged application reads its release repository from that file |
| [`apps/desktop/scripts/electron-builder-config.mjs`](../apps/desktop/scripts/electron-builder-config.mjs) | Publish with the `github` provider, and name [`desktop/build/icons/icon-dark.icns`](build/icons) as the macOS icon | The release destination and the fork's application icon are configured here |
| [`apps/desktop/scripts/package-macos.ts`](../apps/desktop/scripts/package-macos.ts) | Validate the channel file beside each lane's artifacts without promoting it | The merged channel file is assembled from the release by `finalize:mac:channel` |
| [`apps/desktop/scripts/package-target.ts`](../apps/desktop/scripts/package-target.ts) | Record the tag and release type in the completion record, and withhold `GH_TOKEN`/`GITHUB_TOKEN` from packaging subprocesses | The upload needs a record it can trust, and packaging needs no credential |
| [`apps/desktop/package.json`](../apps/desktop/package.json) | Add the `finalize:mac:channel` script | The release workflow calls it |
| [`apps/desktop/scripts/desktop-release-environment.mjs`](../apps/desktop/scripts/desktop-release-environment.mjs) (+ [`.d.mts`](../apps/desktop/scripts/desktop-release-environment.d.mts)), [`verify-macos-signature.mjs`](../apps/desktop/scripts/verify-macos-signature.mjs) | Accept a full certificate common name and derive the short one from it | Two certificates in this keychain share a short name, so name matching is ambiguous |
| [`apps/desktop/tests/desktop-auto-update-environment.spec.ts`](../apps/desktop/tests/desktop-auto-update-environment.spec.ts), [`desktop-upload-plan.spec.ts`](../apps/desktop/tests/desktop-upload-plan.spec.ts), [`macos-app-update-config.spec.ts`](../apps/desktop/tests/macos-app-update-config.spec.ts), [`macos-signature.spec.ts`](../apps/desktop/tests/macos-signature.spec.ts), [`package-macos.spec.ts`](../apps/desktop/tests/package-macos.spec.ts), [`package-target.spec.ts`](../apps/desktop/tests/package-target.spec.ts) | Track the behavior above | Tests describe the behavior this fork ships |

Everything else this subtree needs is its own file: the release workflow, the Agent Notes, the historical release documentation, and this README.

## Dormant assets

| Path | State | Why it is kept |
|---|---|---|
| [`build/entitlements.mac.plist`](build/entitlements.mac.plist), the light, clear, and generic icons in [`build/icons`](build/icons) | Unused: only `icon-dark.icns` is named by the packaging configuration, and upstream's configuration uses no entitlements file | The fork's deleted shell kept its assets here |
| [`docs/releases`](docs/releases/README.md) | Historical release plans | They record what each version intended |

## Tags and releases

A release is tagged `v<version>` and published as a GitHub release in `ceasarXuu/deepseek-harness-desktop` by [the release workflow](../.github/workflows/desktop-release.yml). The tag is the version itself because the updater's GitHub provider compares release tags as semantic versions and derives the prerelease channel from the version's prerelease component, so `0.1.6-alpha.2` publishes `alpha-mac.yml` under tag `v0.1.6-alpha.2`, and a stable version publishes `latest-mac.yml`. The `dsh-v*` prefix belongs to the upstream release train, whose tags arrive with every upstream fetch, so it cannot be shared. The [release destination decision](../.agents/notes/implemented/architecture/2026-09-13-desktop-release-destination.md) owns the feed, the credentials, and the upload validation.

## Pre-release stance

The repository's pre-release stance applies with full force here: with no external consumers of this fork, the correct foundation is preferred over compatibility shims, and on-disk formats may be revised rather than migrated.

## Local toolchain

Running any `pnpm run check:ci:*` aggregate requires a pnpm that is a JavaScript entry point reporting the version pinned by `packageManager` in `package.json`.

Two harness details create that requirement. `scripts/run-gates.ts` spawns every gate as `node <npm_execpath> ...`, which only works when `npm_execpath` names a JavaScript file. Separately, several package scripts invoke `pnpm` again by name, and that nested process enforces the `packageManager` field.

A standalone pnpm binary — the `@pnpm/exe` distribution that a version manager such as mise installs — satisfies neither. It fails the first requirement with `SyntaxError: Invalid or unexpected token` for every gate in the aggregate, and the second with a version-mismatch error. The failures name individual gates, so the shared cause is not obvious from the output.

The remedy is to place a JavaScript pnpm at the pinned version ahead of the binary on `PATH`, for example a shim that execs `node apps/desktop/node_modules/pnpm/bin/pnpm.cjs "$@"`. CI satisfies this by construction, because `pnpm/action-setup` installs pnpm at the version `package.json` pins.

## Building locally

Two levels of cost, for two kinds of change.

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

Use this to check what the packaged application actually does — Resources paths, the bundled runtime, crash handling — none of which the source-tree run reproduces. Updates are not testable here: the updater reads the release feed, and a `--dir` build carries no installer to update from.

**Build the deliverable.** Every package command requires signing and notarization credentials, which CI holds as secrets, so a release is built by the workflow rather than on a workstation:

```sh
pnpm run package:desktop:mac:arm64   # or package:desktop:mac:x64
GH_TOKEN=$(gh auth token) pnpm run upload:mac:arm64
```

A package command prepares the target runtime, materializes and verifies the dsh tree, builds the application, and produces the DMG, ZIP, and their blockmap together with the version's channel metadata. Packaging reads `apps/desktop/.env.macos`, whose release settings never fall back to the shell environment; [its template](../apps/desktop/.env.macos.example) lists every accepted setting. Signing and notarization perform the Apple-side checks the request needs.

The release workflow writes that file from its secrets, packages both macOS targets, verifies signature, Gatekeeper, and the stapled ticket on the artifact it just produced, uploads the binaries, and publishes the merged channel file last. A Windows release stays out of reach: signing needs a SafeNet token attached to a self-hosted runner, so that lane builds an unsigned installer as a workflow artifact and touches no release.

## Releases

| Version | Status | Target | Docs |
|---|---|---|---|
| 0.0.1 | Proposed | macOS (Apple Silicon) | [`docs/releases/v0.0.1`](docs/releases/v0.0.1/README.md) |
| 0.0.2 | Proposed | macOS (Apple Silicon) | [`docs/releases/v0.0.2`](docs/releases/v0.0.2/README.md) |
| 0.0.4 | Proposed | macOS (Apple Silicon, Intel) | [`docs/releases/v0.0.4`](docs/releases/v0.0.4/README.md) |
