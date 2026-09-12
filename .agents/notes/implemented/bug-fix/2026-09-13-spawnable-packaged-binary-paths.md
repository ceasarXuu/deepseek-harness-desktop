# Agent Note: A spawnable path for binaries the packaged harness launches

Status: implemented

English | [中文](2026-09-13-spawnable-packaged-binary-paths.zh.md)

## Problem

Two launch sites inside the packaged desktop application failed, both because the path they held ran through the closure archive rather than to a file.

`glob` and `grep` failed on every call with `glob could not start its search command (ripgrep launch failed)`. `@vscode/ripgrep` resolves its platform package once at module evaluation and exports that path, so the search tools were handed `<Resources>/harness.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`.

Opening a terminal failed with `posix_spawnp failed`. `node-pty` locates `spawn-helper` beside the prebuilt addon it loaded, which is the same kind of path inside the archive.

Neither failure named the path, because Electron patches `fs`: a read of a file the archive left unpacked falls through to `<archive>.unpacked`, so both binaries were present, readable, and executable on disk. A launch does not go through that patch — the operating system receives a path whose parent is a file and fails with `ENOTDIR`.

Measured with the packaged application's own Electron binary re-entered as Node, one path and one binary at a time:

| Launched | Result |
|---|---|
| the ripgrep path inside the archive | `ENOTDIR` |
| that path's unpacked sibling | `ripgrep 15.0.0 (rev 3a612f88b8)` |
| the spawn-helper path inside the archive | `posix_spawnp failed` |
| that path's unpacked sibling, named through `DSH_NODE_PTY_SPAWN_HELPER` | the PTY opens and reads its command's output back |

The artifact was correct in both cases. [`desktop/docs/releases/v0.0.1/packaging.md`](../../../../desktop/docs/releases/v0.0.1/packaging.md) requires each of these files to be unpacked outside `asar`, and the closure build already places them there; nothing read the file through the path that was launched.

## Decision

A binary the harness launches reaches a real path, by whichever of two levers can reach it.

**A path the harness resolves itself is unwrapped at the resolution.** `resolveRgPath()` returns the unpacked sibling when the packaged module's own resolution lands inside an `<name>.asar` archive and that sibling exists, and the resolved path unchanged otherwise. The rule is `executablePath()` in [`search-core.ts`](../../../../packages/fs/tool-fs-search/src/search-core.ts), applied where the lazily resolved platform path is first read. It belongs to the resolution because its callers spawn what it returns, and this package is the only party that knows a platform package was resolved rather than named.

**A path a dependency computes for itself is named by the launcher.** `node-pty` derives its helper path from its own module location inside the closure, where no harness code resolves it; the only lever is the `DSH_NODE_PTY_SPAWN_HELPER` override its patched loader reads first ([`patches/node-pty@1.1.0.patch`](../../../../patches/node-pty@1.1.0.patch)), so the shell sets that variable for the child it spawns, alongside the other installation facts it already states there (`DSH_HOME`, `DSH_DESKTOP_VERSION`). The variable is set only when the unpacked helper exists, because a development run boots from a loose closure whose paths are already real, and naming an absent file there would fail every terminal the way the archive path did.

Nothing about the artifact changes. The archive layout, the archive's unpack rules, the closure manifest, and the [desktop composition](../architecture/2026-09-12-desktop-application-composition.md) stay as they are, and the desktop subtree remains the only party that decides how the closure ships.

## Alternatives considered

**Ship the packages that hold these binaries beside the archive rather than inside it.** Measured to work for ripgrep: with the package absent from the archive, resolution from a module inside the archive walks out of it and returns a real path, and that path launches. Rejected because it makes correctness depend on resolution continuing past an archive that holds no entry for the package, and because each further binary would need the same relocation instead of one rule per lever.

**Rewrite the path at the spawn boundary.** Rejected: the subprocess seam receives a finished argv and does not interpret it, so the rewrite would have to happen inside the provider — where it would silently apply to every spawn, including the ones whose paths are already real — or by patching `child_process` from the launcher, which is invisible both to the seam and to the resolution that produced the value. It also does not reach `node-pty`, which spawns from native code.

**Teach the vendored `node-pty` patch to rewrite this archive's name.** Rejected: the patch would carry a rule about a directory layout chosen outside it, and a second consumer of that patch would inherit the first one's naming.

**Extract the closure into a real directory on first launch.** Rejected: it reaches the same result by trading the archive's install cost for a first-run extraction, a second copy of the closure on disk, and a closure that must be writable at run time, in exchange for a defect two levers absorb.

**Go back to shipping the closure unpacked.** This is the layout the archive replaced, and the reason it was replaced stands: installation enumerates the bundle's files before copying any of them, so a closure staged as loose files costs the user the wait the archive removed.

## Consequences

**Bought**: search and terminal both work in the packaged application, and the build's unpack rule has the effect its own comment claims — the files are outside the archive *and* the launched paths reach them. Any other deployment that packages the harness in an archive gets the same handling.

**Paid**: one harness package carries a packaging convention it did not carry before, and the shell states one more fact about the installation it ships. The resolution rule is inert without an archive in the path; the environment variable is set only where the unpacked file is.

## Testing

[`rg-unpacked.spec.ts`](../../../../packages/fs/tool-fs-search/tests/rg-unpacked.spec.ts) pins the three resolution outcomes: a path inside an archive whose unpacked sibling exists resolves to that sibling, a path inside an archive whose sibling is absent is returned unchanged, and a path containing no archive is returned unchanged. Each case loads its own module instance, because the resolution is memoized once per process.

Against the installed application, the closure's own `resolveRgPath()` returns `<app>/Contents/Resources/harness.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`, and launching that file reports `ripgrep 15.0.0`; the same `node-pty` addon that failed with `posix_spawnp failed` opens a PTY and reads `/bin/echo pty-ok` back once the variable names the unpacked helper.

The second lever has no automated test: it is a variable the shell sets on the child it spawns, and only the packaged application exercises it. The packaging document's native-artifact table states its two ends together.
