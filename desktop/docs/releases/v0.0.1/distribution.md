# Distribution

Status: Proposed

This document describes how a desktop version is numbered, built, published, and delivered to an installed application.

## Versioning

The desktop application has its own version, independent of the harness version it carries.

| Value | Meaning | Where it is read |
|---|---|---|
| Desktop version, for example `0.0.1` | Identifies one desktop release. Drives the update comparison. | `Info.plist` `CFBundleShortVersionString`, and the release tag |
| Harness version, for example `0.1.0-rc.5` | The `dsh` family version the frozen closure was built from | Recorded in the closure manifest and surfaced in the About panel |
| Closure revision | The commit the closure was built from | Recorded in the closure manifest |

Independence matters because the two release trains move at different rates. A packaging defect, a signing fix, or an interface polish item ships as a new desktop version without requiring a harness release; a harness change is picked up by rebuilding the closure and bumping the desktop version. The bundled harness version is displayed so a support conversation can start from a known pair rather than from the application version alone.

The first release is `0.0.1`. The update channel offers only stable releases: the application does not consume prereleases, and publishing a desktop prerelease does not reach installed applications.

## Where releases are published

Releases are published from this repository, `ceasarXuu/deepseek-harness-desktop`, which is public. It is a long-lived fork of `deepseek-ai/deepseek-harness` that takes upstream updates but does not contribute back, so the desktop release train is separate from the upstream one and is the only train this application consumes.

Public visibility is a requirement rather than a preference. The update check reads the release feed without credentials, and a credential cannot be shipped inside an application that a user can unpack.

### Tags

Desktop releases are tagged `desktop-v<version>`, for example `desktop-v0.0.1`.

The `dsh-v*` and `vendor-*` prefixes belong to the upstream release trains, whose tags arrive with the upstream fetch. A desktop release that reused one of those prefixes would eventually collide with an upstream tag, and the collision would surface as a tag that cannot be created rather than as a build failure.

### The update feed is fixed at build time

The repository that publishes releases is compiled into the application as its update feed. Changing it later is possible but costs a release: the last version published from the old feed embeds the new one, and installed applications migrate when they accept that version. This is the reason the decision is recorded rather than left to the release configuration.

### CI prerequisites on the fork

GitHub Actions is enabled on the fork. Two items are configured and one remains.

| Prerequisite | State |
|---|---|
| A protected environment holding the signing certificate and the notarization key | Configured. The `desktop-release` environment restricts deployments to tags matching `desktop-v*` and requires a reviewer before a deployment proceeds |
| The secrets from [`packaging.md`](packaging.md) | Outstanding. Signing and notarization cannot be performed without them, and their absence must fail the pipeline rather than produce an unsigned artifact |
| macOS runners | Available. The repository's existing workflows build a macOS single-file executable, so the runner shape is not new |

### Reaching publication from a fork

The upstream release workflows cannot publish from this repository, and this is by construction rather than by configuration. Their publication steps are manual dispatches guarded by an environment and a tag check, so the automatic steps that do run on a push only pack tarballs without credentials.

They still cost runner time on every push to `master`, and the upstream `ci.yml` is worse than idle here: its jobs target pools that do not exist for this account, so they queue until they time out instead of reporting a result. Workflows are disabled through repository settings rather than by editing their files, which keeps the fork's divergence from the upstream tree at the files listed in [`desktop/README.md`](../../../README.md) and lets an upstream fetch bring their definitions across unchanged.

An upstream workflow file is disabled once, after Actions registers it on the first push. Registration is a consequence of that push, not of enabling anything.

| Workflow | Disposition | Reason |
|---|---|---|
| `ci.yml` | Disable | Jobs target organization-restricted pools and self-hosted labels that do not exist here, so they queue until timeout instead of reporting |
| `release.yml` | Disable | Its pack job runs on every push to `master` and cannot proceed past packing, because publication needs an npm token this fork does not have |
| `release-vendor.yml` | Disable | The same reason, for the vendored framework packages |
| `docs-pages.yml` | Disable | GitHub Pages is not configured for this fork, so the deploy step fails on every documentation change |
| `e2e.yml` | Disable | Requires a model credential this fork does not hold, and triggers on every push and on a schedule |
| `issue-lifecycle.yml` | Disable | Requires a GitHub App private key, and issues are disabled on the fork |
| `issue-policy.yml` | Disable | Automates the upstream project's issue and pull-request policy |
| `sandbox.yml` | Keep | Standard runners, and it exercises the sandbox chain the desktop application depends on |
| `landlock-run.yml` | Keep | Standard runners, scoped to `native/landlock-run` paths |
| `expected-filenames.yml` | Keep | Standard runner and negligible cost |
| `e2b-e2e.yml`, `pi-ai-provider-e2e.yml`, `python-release.yml`, `landlock-run-release.yml` | Keep | Dispatch-only, so they cost nothing unless explicitly run |

### Continuous integration

The fork's own checks live in [`.github/workflows/fork-ci.yml`](../../../../.github/workflows/fork-ci.yml) and run only on standard GitHub-hosted runners, which carry no minute quota for a public repository.

| Job | What it runs |
|---|---|
| static gates | The complete static aggregate: typechecking, the documentation and catalog gates, the module graph, and unused-export analysis |
| unit tests | The package test suite |
| snapshot replay | The keyless snapshot suite over recorded transcripts |
| macos | Typechecking and the test suite on macOS, the platform the desktop release targets |

The macOS job exists because the desktop application depends on platform-specific behavior that a Linux run cannot exercise: the `node-pty` addon, the Seatbelt sandbox rung, and the process inspection the persistent terminal backend performs.

The release pipeline below is additional to this workflow and is triggered by a tag rather than by a push.

## Release pipeline

One workflow on a macOS runner produces every artifact for a release. It runs unattended on a tag and fails loudly, because a partially signed or un-notarized artifact is worse than no artifact.

The workflow depends on the signing and notarization secrets listed in [`packaging.md`](packaging.md), configured once in the repository that publishes releases. They are a one-time setup rather than a per-release task, and their absence must fail the pipeline rather than silently produce an unsigned artifact, because an unsigned application is rejected by Gatekeeper and cannot be updated.

| Stage | Action | Failure mode it prevents |
|---|---|---|
| 1. Build | Install, build the library and web faces, build the frontend | Shipping a stale frontend `dist/` |
| 2. Closure | Materialize the deploy root, replace symlinks with bytes, strip package-manager links | A closure that depends on symlinks the recipient does not have |
| 3. Addon rebuild | Rebuild `node-pty` against the Electron ABI, restore the spawn-helper executable bit | A boot failure at the terminal capability's import |
| 4. Assemble | Copy the closure into `Contents/Resources/harness/`, write the configuration and preset roots | A closure that resolves but is not where the composition looks |
| 5. Sign | Sign nested artifacts innermost-first, then the bundle | A Gatekeeper rejection on a user's machine |
| 6. Notarize | Submit with `notarytool`, wait, staple | A first launch that requires network access or is blocked offline |
| 7. Package | Produce the DMG and the ZIP | A missing update artifact |
| 8. Verify | Run the checks in [`packaging.md`](packaging.md) against the built bundle | Shipping an artifact that fails on a clean machine |
| 9. Publish | Attach the artifacts and the update metadata to the release | An installed application never seeing the version |

Stage 2 uses the same `pnpm deploy` invocation shape as the existing executable build ([`scripts/build-exe-for-python-sdk.ts`](../../../../scripts/build-exe-for-python-sdk.ts)), because the two share the same hoisted, symlink-free closure requirement.

Stage 8 is the gate that makes the pipeline meaningful. It installs the built application into a clean location on the runner and drives a full turn against it, so the checks exercise the artifact rather than the build tree.

### Release artifacts

| Artifact | Consumer |
|---|---|
| `DeepSeek-Harness-<version>-arm64.dmg` | A new user |
| `DeepSeek-Harness-<version>-arm64-mac.zip` | The in-application updater, and a user whose update failed |
| `DeepSeek-Harness-<version>-arm64-mac.zip.blockmap` | Differential updates |
| `latest-mac.yml` | The update feed's version manifest |

### Release checklist

Each item is a gate. The release is published only when all of them hold.

1. The version is bumped in the shell's `package.json`, the closure manifest, and the tag.
2. The workflow completes every stage with no skipped signing or notarization step.
3. The verification stage passes against the built bundle.
4. The DMG is installed on a machine that has never had Node.js or this repository present, and the acceptance criteria in [`README.md`](README.md) are re-walked by hand for the first release.
5. `latest-mac.yml` names the version being published, and its archive URL and size match the uploaded ZIP.
6. The published release is not a draft and not a prerelease, since neither reaches installed applications.

## Update delivery

Updates are delivered by `electron-updater` reading a GitHub release feed. The repository that publishes the releases is public, so the update check requires no credentials and no hosted feed service.

Update metadata is served from the release itself rather than from a separate endpoint, which keeps one source of truth for what the current version is: the newest non-prerelease, non-draft release.

Two properties of macOS updates constrain the pipeline rather than the application code:

**An update only applies to an application whose signature verifies.** The updater validates the downloaded bundle against the running application's signing identity and refuses a mismatch. Code signing is therefore a prerequisite for auto-update, not a parallel workstream, and an unsigned development build cannot exercise this path end to end.

**The updater consumes the ZIP, not the DMG.** The DMG exists for first installation. Both must be published for a release.

## Update behavior

| Aspect | Behavior | Reason |
|---|---|---|
| Check trigger | On launch, and periodically while running | A long-running session should learn about a release without being restarted first |
| Download | In the background, without interrupting the session | A download must never block a running turn |
| Apply | Only after the user accepts a prompt | An agent turn can be long and destructive to interrupt; the user decides when |
| Restart | The application quits, applies, and relaunches | The harness child is restarted with the new closure |
| Session state | Preserved, because it lives under `DSH_HOME` outside the bundle | Updating replaces the application, not the user's data |
| Failure | Reported in the interface, with the release page offered as a manual path | A stalled or corrupt download must not leave the user without a route forward |
| Declining | Remembered for the session, not permanently | The prompt returns on a later launch rather than being dismissed forever |

The About surface displays the desktop version and the bundled harness version, and offers a manual check. That surface is the support entry point when an update fails, so it must be reachable without a terminal and must state the two versions separately.

## Withholding a release

If a published version proves defective, the remedy is to remove it from the feed rather than to publish a corrective version, because a corrective version only reaches users after they accept an update they may already have declined.

Un-publishing is done by converting the release to a draft or to a prerelease. Installed applications that have not yet updated then see the previous version as newest, and applications that already updated are handled by the next release being a higher version than the defective one. This is why the desktop version must increase monotonically, including for withdrawn versions.
