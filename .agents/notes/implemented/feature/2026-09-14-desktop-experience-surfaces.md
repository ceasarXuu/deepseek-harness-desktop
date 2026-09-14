# Agent Note: Desktop recovery, updates, and diagnostics

Status: implemented

English | [中文](2026-09-14-desktop-experience-surfaces.zh.md)

These surfaces belong to the [adopted upstream application](../architecture/2026-09-13-adopt-upstream-desktop.md).

## Problem

The adopted application shipped the recovery, update, and diagnostics surfaces the fork's roadmap asked for, but each was incomplete for the user it exists for — someone with no terminal, no package manager, and no Node.js. The failure page said only that startup failed and left its three actions unexplained, so the two that change the profile looked as safe as restart. A declined update could be forgotten when a later re-check failed, and a failed download or restart handoff was silent. The management window had nowhere to read the versions and paths a support request needs. This note records what each surface now promises, where its state lives, and why each was built in the shell.

## Decision

### Recovery names the failure and gates the profile actions

The local loading page renders the failure text from the main process and explains what each recovery action does rather than only labelling it. Restart is always offered; disabling third-party plugins and resetting Desktop are offered only when the initialized application can repair its profile, which packaged application resources provide, so development projects and early initialization failures expose restart alone. The two profile-mutating actions render as destructive and each carries its own advice line — disabling keeps plugin files and starts without them, resetting deletes Desktop configuration and third-party plugins without a backup — and a clicked action enters a busy state that disables every action, then reports its own failure in place of the page instead of leaving the text unchanged. When a shell resource or preload failure prevents the page itself from loading, a self-contained document carries the same failure text and offers restart always, plus the two profile actions only when profile recovery is available.

### Updates keeps a declined release and reports every failure

A check publishes its phase to every window and retains the available version. The native confirmation names that version and states that the release includes its matching dsh runtime and that the application restarts to finish installing, so the version and the restart are visible before the user accepts. Declining leaves the release known, so a later check that cannot reach the feed reports its error beside the retained version rather than replacing it, and the release stays installable. Accepting waits for an in-flight check and then downloads and verifies the release; a failed download is reported and leaves the release retryable. Once the download succeeds the application stops the dsh child and hands installation plus restart to electron-updater, and a failed handoff is reported too: the application keeps running on the old release with the update still installable.

### Diagnostics lives in the management window

The management window gains a Diagnostics section listing the application and dsh versions, the Harness home, the runtime location, and the last start's outcome, with a copy action for one assembled block and a reveal action for the Harness home. The block is assembled once in the main process from main-process facts and locale labels, so the renderer renders one payload and copies exactly what it shows, reads no filesystem, and invokes no shell; a version it cannot read yet shows as unavailable rather than failing the section. The facts are added to the window that already owns the profile and already carries a preload, a locale payload, and a menu entry, rather than to a new window that would duplicate that wiring for five read-only rows.

## Alternatives considered

- **Give diagnostics their own window.** Rejected: the management window already owns the profile and already carries the preload, locale payload, and menu entry, so the installation facts belong in the surface that already speaks for the installation. A second window would duplicate all of that to show five read-only rows and to reach the same `$DSH_HOME`.
- **Forget a declined release when a re-check fails.** Rejected: the declined version is exactly the fact a user needs when the feed later stops answering, and forgetting it would turn a transient check failure into "no update available". Retaining it keeps Install reachable after the fact, which is the point of having confirmed the release once.
- **Offer every recovery action in every failure.** Rejected: disabling plugins and resetting Desktop mutate the profile, so offering them where packaged resources cannot repair it, or where no profile exists yet, would present actions that cannot run. Gating them on profile recovery keeps the page honest, and restart is the one action every context can perform.

## Consequences

The failure page now names the failure and explains each action, and its profile-mutating actions appear only where they can run, so a context that cannot repair a profile no longer offers actions that would fail; the busy state means a slow recovery no longer leaves the page looking unchanged. A declined update stays installable across a failed re-check, and a failed download or restart handoff is reported rather than silent. Diagnostics turns the versions and paths a support request needs into one copied block, assembled in the main process with no filesystem access in the renderer.

The costs are the ones these choices name: a retained declined release can stay offered after the feed stops answering, which the error text must explain; and the diagnostics block mirrors locale labels, so a new fact is added in both dictionaries and is covered by the section's tests.
