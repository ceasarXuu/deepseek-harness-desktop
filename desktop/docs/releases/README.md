# Desktop releases

English | [中文](README.zh.md)

One directory per shipped desktop version, holding the planning set for that version: what it includes, how it is built and distributed, and what could go wrong.

A release directory describes intended state and is revised until the version ships. Shipped behavior is then owned by the package READMEs and Agent Notes it produced; the release directory stays as the record of what the version set out to be.

| Version | Status | Target | Docs |
|---|---|---|---|
| 0.0.1 | Proposed | macOS (Apple Silicon) | [`v0.0.1`](v0.0.1/README.md) |

## Document roles within a release

| Document | Answers |
|---|---|
| `README.md` | What this version promises, what it excludes, and how completion is observed |
| `architecture.md` | How the processes are arranged and how the harness is booted |
| `packaging.md` | What ends up inside the application bundle and how it is signed |
| `distribution.md` | How a version is versioned, released, and updated in place |
| `experience.md` | What a user without a terminal sees |
| `plan.md` | The order of work and the exit criteria of each stage |
| `risks.md` | What is unverified, what could fail, and what each fallback is |
