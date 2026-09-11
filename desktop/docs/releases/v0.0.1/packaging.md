# Packaging

Status: Proposed

This document describes what ends up inside the application bundle, how native artifacts are handled, how the bundle is signed and notarized, and how the DMG is produced and verified.

## Bundle layout

The harness closure is not placed inside `app.asar`. It is copied as real files under `Contents/Resources/harness/`, and only the Electron shell's own JavaScript is archived.

This is a deliberate choice over `asarUnpack`. The harness performs ESM dynamic import of packages, `createRequire(...).resolve()` of package manifests, `readFile` of per-package client bundles, `fileURLToPath` conversion of worker entries, and spawning of a native addon helper and a ripgrep binary. Placing that tree behind `asar` would require the child process to have working `asar` support under `ELECTRON_RUN_AS_NODE=1` and would make every one of those operations depend on archive semantics. Real files make all of them ordinary filesystem operations with no verification surface.

```
DeepSeek Harness.app/
  Contents/
    MacOS/
      DeepSeek Harness            the Electron binary; also the harness child, entered via ELECTRON_RUN_AS_NODE=1
    Frameworks/
      Electron Framework.framework
      Squirrel.framework, Mantle.framework, ReactiveObjC.framework   updater support, only if the update target requires it
    Resources/
      app.asar                    the shell's own JavaScript: main, preload
      app.asar.unpacked/          anything the shell itself must load natively
      harness/                    the frozen dependency closure, copied verbatim
        node_modules/
          @deepseek-ai/...
        config/
          cordis.yml              the shipped composition entry
          agent-presets/          the shipped preset roots
      electron.icns
    Info.plist
    CodeResources
```

The closure is materialized at build time with the same mechanism the executable build already uses: `pnpm deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true` against a dependency-only manifest. Hoisted layout matters for two reasons: it gives the Loader one stable instance of each package to resolve, and it lets the post-deploy pass replace every staged symlink with the target's bytes.

The packaged child passes the closure directory as `bareModuleBaseUrl`, so bare specifiers in the composition resolve from the application's own dependency tree rather than from wherever the configuration file happens to sit. This is the same mechanism the SDK runtime executable uses, and it is what keeps a closed plugin set closed.

## Application identity

| Value | Setting | Notes |
|---|---|---|
| Bundle identifier | `xuyutech.dsh` | Set as `CFBundleIdentifier` in `Info.plist` and as `appId` in the packaging configuration. Must match on every release: the updater compares it, and a change would present updates as a different application |
| Application name | `DeepSeek Harness` | `CFBundleName` and the display name |
| Team identifier | `3BCJ5SAVU2` | Implied by the signing certificate. The updater verifies that a downloaded update carries the same team, so the certificate must not be replaced with one from another team |

The bundle identifier is deliberately not a reverse-DNS name under `ai.deepseek`. This is a third-party distribution, and the identifier states who publishes the application rather than who authored the harness it carries.

## Native artifacts

Everything in this table must survive copy, keep its executable bit, and carry a valid signature.

| Artifact | Source | Reached how | Packaging consequence |
|---|---|---|---|
| `pty.node` | `node-pty`, rebuilt against Electron's ABI | Eager static import in `@deepseek-ai/dsh-subprocess-local` | Must be loadable before tree construction completes; ABI must match the Electron binary exactly |
| `spawn-helper` | `node-pty` | Spawned by the addon when a PTY opens | Executable bit, signed, and locatable. The patched loader probes `process.execPath + '-spawn-helper'` first and honours `DSH_NODE_PTY_SPAWN_HELPER`, so the helper may sit beside the Electron binary instead of inside the addon directory |
| `rg` | `@vscode/ripgrep`, platform optional package | Lazily imported on first search tool call | Must be a real executable file outside `asar` |
| `libvips` and its `sharp` addon | `sharp`, `@img/sharp-*` platform packages | Imported by `@deepseek-ai/dsh-attachment-local` | Native addon plus a dynamically loaded library; both signed |
| `lib/worker.cjs` entries | `@deepseek-ai/dsh-workflow-worker-thread`, `@deepseek-ai/dsh-code-runtime-worker-thread` | `new Worker(fileURLToPath(...))` | Must remain a sibling CommonJS file next to its built host, and `import.meta.url` must survive packaging unchanged |

Two artifacts from the general dependency set are absent on macOS and require no handling: `koffi` is imported only on Windows code paths, and `@deepseek-ai/node-addon-landlock-run` publishes Linux-only packages.

`node-addon-require-builtin` is not packaged. The child process is launched with `--expose-internals`, which [`vendor/loader/src/internal.ts`](../../../../vendor/loader/src/internal.ts) checks before consulting that addon. Dropping it removes one native addon and one ABI dependency from the release.

### The node-pty rebuild

`node-pty` is a `node-gyp` addon, so it must be compiled against the Electron binary's module version rather than a stock Node's. The build runs the addon rebuild as an explicit packaging stage and then verifies the result by loading it in the packaged child, because a mismatch surfaces at import time during boot rather than at install time.

The helper's executable bit is restored by the package's own postinstall in the repository ([`packages/subprocess/subprocess-local`](../../../../packages/subprocess/subprocess-local/package.json)), but `pnpm deploy` does not run it, so the packaging stage restores the bit after copying. The executable build's build script performs the equivalent step for the same reason.

## Signing

The application is signed with a Developer ID Application certificate and the hardened runtime enabled. It is not sandboxed.

**App Sandbox is not enabled, and cannot be.** The agent executes shell commands, reads and writes the user's workspace, and spawns language processes. A sandboxed application cannot do those things. The direct consequence is that this application is distributed outside the Mac App Store, because the App Store requires the sandbox entitlement. Distribution is therefore a signed and notarized DMG, which is what a user can install by dragging and double-clicking.

The signing identity is `Developer ID Application: Xu Zhang (3BCJ5SAVU2)`. A Development certificate signs for registered devices only, and an Apple Distribution certificate is for the App Store, so neither substitutes.

### Entitlements

One entitlements file covers the whole bundle, because there is only one executable: the harness child is the Electron binary re-entered with `ELECTRON_RUN_AS_NODE=1`, so it shares the signature, the entitlements, and the team identifier of the main process.

| Entitlement | Reason |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 in the renderer requires writable-executable memory |
| `com.apple.security.cs.allow-unsigned-executable-memory` | V8 code generation paths |
| `com.apple.security.cs.disable-library-validation` | The closure loads native modules and dynamic libraries that are signed by their upstream publishers rather than by this application's build |
| `com.apple.security.cs.allow-dyld-environment-variables` | Electron's child-process launch path |

Sandbox entitlements are absent by design: no `com.apple.security.app-sandbox`, no `com.apple.security.inherit`.

### Signing order

Nested code is signed before its container, and the container's seal is computed over what is already signed.

1. Every Mach-O file in `Contents/Resources/harness/`: the `sharp` addon and its libraries, `pty.node`, `spawn-helper`, `rg`.
2. The Electron framework and its helpers.
3. `Contents/MacOS/DeepSeek Harness`.
4. The `.app` bundle as a whole.

Signing the closure's binaries individually is what makes step 4 verifiable: `codesign --verify --deep --strict` walks the bundle and reports a nested binary that is unsigned, has a broken signature, or has been modified after signing.

### Notarization

Notarization is submitted with `notarytool` and the result is stapled to the `.app` before the DMG is built, so the DMG contains an already-stapled application and works on a machine that is offline at first launch. The DMG itself is then signed and, if the toolchain supports it, stapled as well.

### Signing credentials

Developer ID signing and notarization both require the paid Apple Developer Program membership. A free Apple ID issues development certificates that sign only for registered devices and cannot distribute or notarize.

The Developer ID Application certificate is installed on the build machine, so local builds can sign immediately. Notarization needs credentials that are not yet configured, and they come from one of two sources.

| Item | Where it comes from | Secret | State |
|---|---|---|---|
| Developer ID Application certificate | Certificates, Identifiers and Profiles, exported as a password-protected `.p12` | `CSC_LINK`, `CSC_KEY_PASSWORD` | Present in the login keychain; still needs exporting for CI |
| App Store Connect API key: the `.p8` file | Users and Access, Integrations | `APPLE_API_KEY` | Not configured |
| The same key's key identifier | The same page | `APPLE_API_KEY_ID` | Not configured |
| The key's issuer identifier | The same page | `APPLE_API_ISSUER` | Not configured |
| Team identifier | Membership | Not secret, recorded with each release | `3BCJ5SAVU2` |

An App Store Connect API key is preferred over an Apple ID with an app-specific password because the key is scoped, revocable, and does not depend on a person's account credentials. Either satisfies `notarytool`.

Until notarization credentials exist, a locally built DMG is signed and installs on a machine that accepts it explicitly, but a machine that downloads it will refuse to launch it because the notarization ticket is absent. That is the difference between a build for the person producing it and a build for a recipient.

The certificate is team-scoped and valid for years, but it is the single artifact that makes every published release verifiable and updatable, so its expiry is tracked rather than rediscovered during a release.

## DMG

The installer is a single DMG per architecture containing the application and an `Applications` symlink, with a background image and a fixed icon layout so the drag-to-install gesture is obvious.

A ZIP archive of the same application is built alongside the DMG in the same release. The in-application updater consumes the ZIP, not the DMG, so both artifacts are required even though only the DMG is presented to a new user.

### Size budget

The uncompressed bundle is dominated by two runtimes and one closure. The budget is recorded so a regression is visible rather than discovered at release time.

| Component | Order of magnitude |
|---|---|
| Electron framework and its helpers | 150 MB |
| Harness closure, including the built frontend, client plugin bundles, and the syntax-highlighting grammars | 60–120 MB |
| The harness child adds no second Node runtime under the selected carrier | 0 MB |

The DMG compresses this substantially. The budget is a bound to measure against, not a target: the value recorded in the plan is the first release's measured size, and later releases compare against it.

## Packaging verification

Packaging is verified by running these checks against a built artifact on a macOS machine that has no development tooling installed, and each is a release gate rather than a recommendation.

| Check | Command | Rejects |
|---|---|---|
| Signature integrity | `codesign --verify --deep --strict --verbose=2` | Unsigned or post-signing modified nested binaries |
| Gatekeeper acceptance | `spctl --assess --type execute` | A bundle that would be refused on a user's machine |
| Notarization ticket | `xcrun stapler validate` | A bundle that requires network access to launch |
| Minimum system version | Read `LC_BUILD_VERSION` with `otool -l` and compare against the declared minimum | A bundle claiming to run on a macOS it cannot |
| Closure completeness | Boot the packaged child on a clean machine and complete one turn | A lazily imported dependency that was pruned by accident |
| Orphan check | Quit and confirm no descendant process and no bound port remain | A child that outlives its parent |

The minimum system version is whatever the selected Electron line supports, and the first release records the measured value rather than asserting one. The repository already owns a checker for the equivalent property in the executable build ([`scripts/check-macos-deployment-target.py`](../../../../scripts/check-macos-deployment-target.py)); the desktop equivalent reuses that approach.
