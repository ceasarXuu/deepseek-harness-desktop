# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop distribution of DeepSeek Harness: a signed, self-contained macOS application that runs the harness and its browser interface without a terminal, a system Node.js, or any separately started service.

The harness itself lives in [`packages/`](../packages/README.md) and [`apps/cli`](../apps/cli/README.md) and is unchanged by this subtree. `desktop/` owns only the packaging and shell layers that turn a composed harness into an installable application.

## Layout

| Path | Responsibility |
|---|---|
| [`docs/releases/`](docs/releases/README.md) | Per-release planning: scope, architecture, packaging, distribution, and risks for one shipped desktop version |
| `apps/shell/` | The Electron application: main process, preload, window lifecycle, harness supervision, native dialogs, updater |
| `packages/bundle-desktop-app/` | The Cordis bundle the composition boots: the patch layer over `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, the desktop runtime glue, and the packaged entry |
| `runtime-closure/` | The dependency-only deploy root whose closure is what the packaged application ships. A workspace member for dependency resolution only, like `python/sdk-runtime` |
| `build/` | The closure build script, entitlements, staged icon sources, and the generated `.icns` |

## Relationship to the harness

The desktop application is a composition, not a fork. It boots the same plugin tree that `dsh --profile web` boots, through the same `boot()` entry in [`packages/boot/app-boot`](../packages/boot/app-boot/README.md), from a frozen dependency closure instead of a profile directory.

Three harness contracts shape every design decision here, and each is owned by its package rather than by this subtree:

- Bare-specifier plugin resolution requires the Loader's `internal` module access ([`vendor/loader/src/internal.ts`](../vendor/loader/src/internal.ts)).
- The default persistence backend eagerly imports `node:zlib` zstd, and the session-search index imports `node:sqlite` ([`packages/session/session-persistence-jsonl`](../packages/session/session-persistence-jsonl/README.md)).
- The terminal capability eagerly loads the `node-pty` native addon ([`packages/subprocess/subprocess-local`](../packages/subprocess/subprocess-local/README.md)).

## Development model

This repository is a long-lived fork of `deepseek-ai/deepseek-harness`. Development happens here; upstream `master` is fetched only to take updates. Nothing developed for the desktop application is contributed back.

That arrangement makes one property load-bearing: **the cost of pulling upstream is proportional to how many upstream-owned files this subtree edits.** Every edited upstream file is a merge conflict at the next sync, so desktop work adds new files by preference and modifies existing ones only where composition requires it.

### Upstream-owned files this subtree edits

The list is deliberately short and every entry is an additive list insertion, not a change to upstream behavior. Adding an entry to this table is a decision, not a side effect.

| File | Edit | Why it cannot be avoided |
|---|---|---|
| [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | Add `desktop/*` and `desktop/apps/*` to `packages` | Workspace membership is what makes the shell and the new packages resolvable and covered by the dependency checks |
| [`tsdown.config.ts`](../tsdown.config.ts) | Add `desktop/packages/*/*` to `workspace` | The build runs per package over an explicit workspace glob, so a package outside it is never built and never lands in the closure |
| [`tsconfig.base.json`](../tsconfig.base.json) | Append `./desktop/packages/*/src` and `./desktop/apps/*/src` to the existing `@deepseek-ai/dsh-*` path array | The path map is what lets workspace imports resolve to source rather than to built output, and its arrays are explicit directory lists |
| [`tsconfig.host.json`](../tsconfig.host.json) | Add a glob covering desktop package sources and tests | This face's `include` seeds the program that typechecks the host side, and desktop packages are not reachable by import from anything already listed |

Everything else the desktop application needs is a new file: the shell, the bundle, the closure manifest, the build configuration, the release workflow, the Agent Notes, and this documentation.

The rule that keeps the list short is that a desktop package may not modify a harness package in place. Where the composition needs different behavior — the directory picker is the current example — the desktop subtree supplies its own implementation over the same capability seam and leaves the existing provider untouched.

An alternative layout exists: placing the new packages under an existing `packages/<group>/` directory would be matched by three of the four globs above, reducing the list to one file. It is not chosen, because a dedicated subtree states which packages this fork adds and keeps them out of upstream's package inventory, and four list insertions are cheaper than the ambiguity.

### Tags and releases

Desktop releases use the `desktop-v*` tag prefix. The `dsh-v*` prefix belongs to the upstream release train, and that train's tags arrive with the upstream fetch, so sharing the prefix would eventually collide.

### Pre-release stance

The repository's pre-release stance applies with full force here: with no external consumers of this fork, the correct foundation is preferred over compatibility shims, and on-disk formats may be revised rather than migrated. This is why the desktop design carries no migration path for a format it is the first to write.

### Local toolchain

Running any `pnpm run check:ci:*` aggregate requires a pnpm that is a JavaScript entry point reporting the version pinned by `packageManager` in `package.json`.

Two harness details create that requirement. `scripts/run-gates.ts` spawns every gate as `node <npm_execpath> ...`, which only works when `npm_execpath` names a JavaScript file. Separately, several package scripts invoke `pnpm` again by name, and that nested process enforces the `packageManager` field.

A standalone pnpm binary — the `@pnpm/exe` distribution that a version manager such as mise installs — satisfies neither. It fails the first requirement with `SyntaxError: Invalid or unexpected token` for every gate in the aggregate, and the second with a version-mismatch error. The failures name individual gates, so the shared cause is not obvious from the output.

The remedy is to place a JavaScript pnpm at the pinned version ahead of the binary on `PATH`. CI satisfies this by construction, because `pnpm/action-setup` installs pnpm at the version `package.json` pins.

### Building locally

Three levels of cost, for three kinds of change.

**Run from the source tree.** The shell reads its runtime location from `DSH_DESKTOP_CLOSURE`, so changes to the shell or to the desktop bundle need no packaging at all. The value is the directory holding `harness.asar`, which is what a packaged application has in its `Resources`:

```sh
pnpm --filter @deepseek-ai/dsh-desktop-app run build
pnpm --filter @deepseek-ai/dsh-desktop-shell run build
DSH_DESKTOP_CLOSURE="$PWD/desktop/build/out" \
  ./desktop/apps/shell/node_modules/.bin/electron desktop/apps/shell
```

This is the loop for interface work and harness behavior. It exercises the same child process, readiness record, and window the packaged application uses, and it skips signing entirely.

**Install a development build.** `--dir` stops after the assembled application, so there is no installer to compress and no notarization round trip:

```sh
node desktop/build/package-app.mjs --dir
ditto "desktop/apps/shell/dist/mac-arm64/DeepSeek Harness.app" "/Applications/DeepSeek Harness.app"
```

Use this to check what the packaged application actually does — Resources paths, the login-shell `PATH` resolution, crash handling — none of which the source-tree run reproduces. Updates are not testable here: the updater reads the release feed, and a `--dir` build carries no installer to update from.

**Build the deliverable.** `node desktop/build/package-app.mjs` produces the DMG and the ZIP, signed with the keychain identity. Add `DSH_DESKTOP_NOTARIZE=1` with notarization credentials in the environment to produce what a release ships.

All three reuse whatever closure exists, because the closure is the slow step and changes least. `--skip-closure` is therefore implied once one has been built; delete `desktop/build/out/harness.asar` to force a rebuild after changing a harness package.

## Releases

| Version | Status | Target | Docs |
|---|---|---|---|
| 0.0.1 | Proposed | macOS (Apple Silicon) | [`docs/releases/v0.0.1`](docs/releases/v0.0.1/README.md) |
