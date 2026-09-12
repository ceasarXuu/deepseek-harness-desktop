# Agent Note: The desktop application composition and shell

Status: implemented

English | [中文](2026-09-12-desktop-application-composition.zh.md)

## Problem

The desktop distribution needs the harness to run inside a packaged application, on a machine with no Node.js, no package manager, and no terminal. The harness as shipped assumes the opposite: [`apps/cli`](../../../../apps/cli/README.md) resolves bundles from a profile directory under the harness home, mounts plugins by bare name through Node's module resolver, and — as [`desktop/docs/releases/v0.0.1/architecture.md`](../../../../desktop/docs/releases/v0.0.1/architecture.md) records — installs a process-exiting handler and force-mounts an HMR service, both of which belong to an interactive terminal application.

Running the harness inside the Electron main process is not available either. The terminal capability imports `node-pty` eagerly, bare-specifier resolution requires Node's internal ESM loader, and the launcher's failure handler would terminate the whole application on one unhandled rejection.

## Decision

### The harness is a child process booted from a frozen closure

The shell spawns this process re-entered as Node (`ELECTRON_RUN_AS_NODE=1`) with `--expose-internals`, running `<closure>/node_modules/@deepseek-ai/dsh-desktop-app/lib/entry.js`. One binary, one signature, and no second runtime in the bundle.

The entry calls `boot()` rather than `runProfile()`. That is what keeps the profile directory out of the picture entirely: no `$DSH_HOME/profiles` is created, no package manager runs, and the composition is whatever the closure ships.

### The desktop composition layers over the browser composition

The desktop bundle composes `dsh-base`, then `dsh-web-app`, then its own patch. Only three rows differ from the browser deployment, so the browser roster, the transport, and the agent-preset plane arrive unchanged rather than being restated:

| Row | Desktop value | Reason |
|---|---|---|
| `webserver` | loopback, port `0` | One harness per window; a fixed port turns a second instance into a bind failure |
| `web-runtime` | `printUrl: false`, `surfaceContext: false` | The URL line is a human readiness signal, and the web-surface prompt orients an agent working on the served application |
| `client-hmr` | disabled | A packaged closure is immutable, so the reload watcher has nothing to observe |

The desktop runtime glue does one thing the browser glue does not: it writes a structured readiness record on stdout after the Loader settles, which is how the shell learns the bound port.

**The readiness contract.** `dsh-desktop-ready {"port":N,"url":"...","version":"..."}` on one line. A supervisor parses it instead of the browser's prose URL line, and it is emitted only after Loader settlement so a sibling row cannot still be mounting when the window opens.

### The closure is built by a verifiable script

[`desktop/build/build-closure.mjs`](../../../../desktop/build/build-closure.mjs) performs the deploy and then repairs and verifies the result. A bare `pnpm deploy` was measured to produce a closure that does not boot: `link:` overrides leave the vendored framework packages out entirely, symlinks point back into this repository, and four declared workspace dependencies were silently omitted.

The script therefore re-adds any declared dependency the deploy did not place, replaces every symlink with a real copy, and fails loud when a declared dependency is absent or any symlink survives. The closure is what the application carries, so it is checked rather than trusted.

## Alternatives considered

**Run the harness in the Electron main process.** Rejected for the three reasons in the Problem: the eager native addon, the Loader internals requirement, and the launcher's process-exiting handler. It would also make a harness crash take the application with it.

**Ship the `pkg --sea` single-file executable the SDK runtime uses.** Rejected as the first carrier: it adds a virtual filesystem between the harness and its own package tree, which puts client-bundle reads, `createRequire` resolution, and worker entry paths behind archive semantics. It remains the documented fallback in [`desktop/docs/releases/v0.0.1/architecture.md`](../../../../desktop/docs/releases/v0.0.1/architecture.md) if the closure approach fails.

**Restate the browser roster in a desktop bundle.** Rejected: the desktop surface is the same browser interface, so a second copy of fifty rows would drift from the first without expressing any difference.

**Make the shell print the readiness record.** Rejected: the harness is the only party that knows when its tree has settled, and a shell that guessed at readiness by polling would open the window against a half-mounted composition.

## Consequences

**Bought**: a desktop application whose harness boots from a closure the application carries, with no Node installation, no profile directory, and no package manager; a composition that differs from the browser deployment in three rows; and a closure build that fails when it is incomplete rather than producing a boot error at the user.

**Paid**: the closure is roughly 355 MB on disk before compression, because it carries every package the composition can mount. The readiness record is a new protocol between the shell and the harness, so both ends must change together.

**Not yet verified**: the packaged artifact. The shell and the closure are exercised from the source tree; signing, notarization, and the DMG are Stage 3.
