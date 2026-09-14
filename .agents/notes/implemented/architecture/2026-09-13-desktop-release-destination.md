# Agent Note: Publish Desktop releases from this repository

Status: implemented

English | [中文](2026-09-13-desktop-release-destination.zh.md)

The application that consumes the release is the [adopted upstream application](2026-09-13-adopt-upstream-desktop.md); what a release carries is the [runtime archive](2026-09-13-desktop-runtime-archive.md).

## Problem

The packaged application checks for updates after its window opens, so it needs a destination this fork can publish to and the application can read. Upstream's destination is neither: `download.deepseek.com` serves upstream's builds, and its upload path needs Tencent COS credentials this fork does not hold. A destination the fork cannot publish to makes every release a manual distribution, and one the application cannot read leaves the installer with no update path at all.

## Decision

A Desktop release is a GitHub release in `ceasarXuu/deepseek-harness-desktop`, the repository this fork maintains, and the update feed is electron-updater's GitHub provider.

- `electron-builder.config.mjs` publishes with `provider: 'github'` and the repository coordinates, and packaging writes the updater's two files itself: `app-update.yml` into the application's resources with the repository and release type, and the version's channel metadata beside the artifacts. It writes both because electron-builder emits them only in a pass that builds an installer target, and this application builds its installers from an already packaged directory; left to electron-builder, an installed application would carry no feed and a release would publish metadata that names no artifact.
- The release tag is `v<version>`. The provider compares release tags as semantic versions and derives the prerelease channel from the version's own prerelease component, so `0.1.5-rc.2` publishes `rc-mac.yml` under tag `v0.1.5-rc.2` and an rc build's updater looks for exactly that channel file. A stable version publishes `latest-mac.yml`, and GitHub's `releases/latest` never selects a prerelease. Update checks read the repository's public releases feed and `releases/latest` rather than the API, so they consume no API quota.
- [`upload-target.ts`](../../../../apps/desktop/scripts/upload-target.ts) uploads through the GitHub REST API with `GH_TOKEN` or `GITHUB_TOKEN`. It validates the local artifacts first — completion record, version, channel metadata, sizes, SHA-512 — then creates the release when its tag has none, sets the prerelease flag from the version, replaces an asset of the same name, and uploads the channel metadata last so a reader never sees metadata for an artifact that is not there yet.
- [`desktop-release.yml`](../../../../.github/workflows/desktop-release.yml) builds both macOS targets on hosted runners, imports the signing certificate into a temporary keychain, notarizes with an App Store Connect key, verifies signature, Gatekeeper, and the stapled ticket on the artifact it just produced, and publishes only for a `v*` tag or an explicit manual run. Its tag guard rejects a tag that does not name the packaged version, because the updater resolves `<channel>-mac.yml` inside that tag.

`DSH_DESKTOP_UPDATE_REPOSITORY` names the repository for the test deployment, so a local or staging run cannot publish to the production repository by accident.

## Alternatives considered

- **Keep the Tencent COS destination.** Rejected: it needs credentials only upstream holds, plus an HTTP origin this fork would have to run. The repository's own hosting removes both.
- **The generic provider over a fixed origin.** Rejected: it fetches the channel file from one stable URL, and GitHub serves assets under a per-tag path. Only `latest` would resolve, so prerelease channels — which the current version needs — could not exist.
- **Channel metadata on GitHub Pages, artifacts on releases.** Rejected: the channel file's artifact paths are relative to its own URL, so publishing from Pages means rewriting them to absolute asset URLs and keeping a second deployment in step with every release.
- **Let electron-builder publish (`--publish always`).** Rejected: the packaging path deliberately keeps publishing off, because the upload validates a completion record written only after signing and notarization succeed, checks artifact sizes and digests against the channel metadata, and orders the channel metadata last. electron-builder's own publisher does none of that.
- **Draft releases with a manual publish step.** Rejected: the updater ignores drafts, so a forgotten second step would look like a release that never reached users.
- **A private release repository.** Rejected: an unauthenticated update check cannot read one, and the application holds no credential to read it with.

## Consequences

The repository's releases are the update feed, so it has to stay public and its tags have to name versions: an update check fails with a channel-file error when the tag and the packaged version disagree, which the workflow's guard catches before anything is published.

The macOS lanes run on hosted runners and need the signing certificate and the notarization key as secrets in the `desktop-release` environment. Both lanes use the Apple Silicon image: the x64 lane runs its own x64 toolchain under Rosetta there, because the Intel macOS runner labels are being retired.

Windows cannot publish from CI yet: upstream's signing path needs a SafeNet token attached to a self-hosted runner, so the Windows lane builds an unsigned installer as a workflow artifact and touches no release. A Windows release stays blocked until that runner exists.

Uploads use the workflow's own token, which needs `contents: write` on this repository — a permission the release job requests and the rest of the workflow does not.
