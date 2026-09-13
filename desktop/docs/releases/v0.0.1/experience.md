# User experience

Status: Proposed

This document describes what a user without a terminal sees: first run, workspace and credential handling, the runtime's visible lifecycle, and how failures reach the interface.

## The governing rule

No step in any user-facing flow may require a terminal, a command, an environment variable, or a file edited by hand.

That rule excludes more than it first appears. It rules out documenting a workaround as an environment variable, telling a user to reinstall, and leaving a failure visible only in output the user cannot see. It also means the application owns concerns that a command-line deployment delegates to the person running it: where data lives, which shell environment the agent inherits, and what happens when the runtime dies.

## First run

1. The user opens the downloaded DMG and drags the application to `Applications`.
2. On first launch, macOS presents the standard confirmation for an application downloaded from the internet. The release is signed and notarized so this is the only Gatekeeper interaction and no override is required.
3. The application opens its window and shows the interface immediately; the harness child is already booting behind it.
4. Onboarding presents the internal-testing notice, then the credential step, using the existing shipped onboarding sequence.
5. The user selects a workspace folder through a native macOS folder chooser.
6. The user sends a first message and a turn completes.

Steps 4 and 5 reuse the shipped interface's own onboarding and workspace selection rather than inventing a desktop-specific flow, so the two surfaces do not diverge. The credential step appears only when the user cannot reach any provider, which is the shipped behavior of the Models onboarding contribution.

The window does not wait for the harness before appearing. A blank window during startup is a worse experience than a window that shows its own loading state, and the harness becomes ready well within the startup budget recorded in [`plan.md`](plan.md).

## Workspace selection

The workspace chooser is a native macOS panel presented by the shell, not the `osascript`-backed chooser the browser composition uses.

The reason is dialog ownership rather than availability. A chooser spawned as a separate process cannot be given the application window as its parent, so it can appear behind the window or on another space. The harness's directory-picker seam names Electron as an intended native provider, and the desktop composition supplies one. The existing provider packages are unchanged and keep serving the browser composition.

The selected workspace is the working directory of the harness child, so it is also the root the sandbox policy and the filesystem tools derive from. Selecting a different workspace is a session-level action the shipped interface already supports.

## Shell environment

When macOS launches an application from the Finder, it provides a minimal `PATH` containing only the system directories. The agent's shell tool would then fail to find tools the user installed themselves, such as a Homebrew-installed runtime or a version manager's shims, and the failure would look like the agent being broken rather than like a missing path.

The shell therefore resolves the user's login environment once at startup, by running the user's login shell in interactive mode and reading its `PATH`, and passes the result to the harness child. This is the approach editor applications take for the same reason. The resolved environment is cached for the session and refreshed when the shell restarts.

Because the child inherits this environment, the agent's shell tool sees the same tools the user would see in their own terminal, which is the behavior a user expects without being told that it required work.

## Runtime lifecycle

| Event | Behavior |
|---|---|
| Launch | The shell acquires a single-instance lock, starts the harness child, and shows the window |
| Ready | The child reports its bound port; the window loads the interface |
| Window close | The window closes; the application and the harness child keep running, and the dock icon reopens the window. Closing a window must not silently kill a turn in progress |
| Quit | The shell signals the child, which disposes the Cordis tree so pending writes drain, then exits. The shell waits for the child before exiting, and terminates it if it does not exit |
| Child exits unexpectedly | The window shows a failure state with a restart action and a route to diagnostics, rather than a frozen or blank interface |
| Child restart | The shell respawns the child against the same `DSH_HOME` and workspace; conversations are recovered from the session log |
| Second launch | The running application is brought forward instead of a second instance starting |

Running a second instance is refused rather than tolerated. The harness holds process-local state and binds a port; two instances sharing one `DSH_HOME` would produce interleaved session writes with no benefit to the user.

## Failure surfaces

This is the largest gap between the shipped browser composition and what a user without a terminal needs, and closing it is part of this release rather than a follow-up.

Today the harness's own log output goes to the host process's standard error, where an application user cannot reach it. Separately, the agent-error frame the host emits is recorded in the client runtime's state but is not rendered by any shipped component, so an agent failure with no turn position is effectively invisible.

The release closes both:

| Surface | Content | Reachable from |
|---|---|---|
| Runtime log | Everything the harness child writes to standard output and standard error, with timestamps and severity, in a bounded in-memory buffer | A log panel in the interface, and a menu item |
| Agent failures | The agent-error state the runtime already records, rendered where the conversation is | The conversation itself |
| Export | The captured runtime log alongside the existing session-log export | The log panel |

Capture happens in the shell, which owns the child's pipes, and is forwarded to the interface over a preload-exposed channel. The log panel is bounded so a long-running session cannot exhaust memory, and the export path is what makes a support conversation possible without asking the user to open a terminal.

A boot failure — a configuration error, an unavailable port, a native addon that will not load — is reported through the same surface, with the failing stage named, because these are the failures most likely to be encountered on a machine that differs from the build machine.

## Application chrome

The menu bar carries the standard macOS items the interface depends on: the application menu with About, Check for Updates, and Quit; an Edit menu, which is required for copy, paste, and selection to work in the interface's text inputs; Window; and Help.

The dock icon is present and the application is a regular foreground application, because the user interacts with a window and expects the usual application-switching behavior. There is no menu-bar-only mode.

Theme, language, and interface layout all come from the shipped browser client, so the desktop application inherits the interface's existing settings surfaces rather than duplicating them.

## What remains out of reach without a terminal

Two capabilities stay outside the application by design in this version, and the interface must present them as unavailable rather than letting them fail confusingly.

Installing or updating plugins is a build-time concern for this release. The packaged closure is frozen, and the shipped plugin inventory surface is read-only, which is already its shipped behavior.

Editing the composed configuration is likewise not exposed. The configuration the application boots is the one shipped inside the bundle. Users who need a different composition are served by the repository's own command-line entry points, which remain the supported path for that.
