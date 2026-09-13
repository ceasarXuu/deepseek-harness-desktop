#!/usr/bin/env node
/**
 * Materialize the desktop application's runtime closure.
 *
 * The closure is what the packaged application carries, so the artifact has to
 * be verifiable rather than trusted. A bare `pnpm deploy` leaves symlinks
 * pointing back into this repository and, in the measured run, silently omitted
 * four declared workspace dependencies. This script performs the deploy and then
 * repairs and verifies the result, failing loud on any gap rather than
 * producing a closure that boots into a missing-plugin error.
 *
 * Usage: node desktop/build/build-closure.mjs [output-directory]
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = join(repo, 'desktop/runtime-closure/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const destination = resolve(process.argv[2] ?? join(repo, 'desktop/build/out/closure'))
const scopeDir = join(destination, 'node_modules/@deepseek-ai')

function fail(message) {
  console.error(`build-closure: ${message}`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with status ${String(result.status)}`)
}

/** Every workspace package by npm name, so a dependency the deploy omitted can be repaired from source. */
function workspaceIndex() {
  const index = new Map()
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      const manifestFile = join(child, 'package.json')
      if (existsSync(manifestFile)) {
        try {
          const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'))
          if (typeof parsed.name === 'string') index.set(parsed.name, child)
        } catch {
          // Another gate owns malformed manifests; the closure build skips them.
        }
      }
      walk(child, depth + 1)
    }
  }
  for (const dir of ['packages', 'vendor', 'desktop/packages', 'apps', 'native/landlock-run/packages']) {
    walk(join(repo, dir), 0)
  }
  return index
}

/** Replace every symlink under `dir` with a real copy of what it points at. */
function materialize(dir) {
  let replaced = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const target = realpathSync(child)
      rmSync(child, { recursive: true, force: true })
      cpSync(target, child, { recursive: true, dereference: true })
      replaced++
      continue
    }
    if (entry.isDirectory()) replaced += materialize(child)
  }
  return replaced
}

/** Every symlink still present under `dir`. */
function findLinks(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isSymbolicLink()) found.push(child)
    else if (entry.isDirectory()) findLinks(child, found)
  }
  return found
}

/**
 * Files that are never loaded at runtime, removed to keep the artifact small.
 *
 * The installer's cost is file count rather than bytes: Finder enumerates the
 * whole bundle before it copies any of it, so tens of thousands of declarations
 * and source maps make installation slow for no runtime benefit.
 *
 * Only declarations and maps go. `lib/types/` stays: `tsc -b` emits real
 * JavaScript there and `tsdown` bundles from it, so packages import each other's
 * `lib/types/*.js` at runtime — removing the directory breaks the tree.
 *
 * Licenses stay, because redistributing a package without its license is not
 * this build's decision to make. Sources stay, because several packages expose a
 * `./src/*` export subpath that something may reach at runtime.
 */
const PRUNE_PATTERNS = [
  /\.d\.ts$/,
  /\.d\.ts\.map$/,
  /\.map$/,
]

/** Remove every file matching the prune rules and return how many went. */
function prune(dir) {
  let removed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      removed += prune(child)
      continue
    }
    if (PRUNE_PATTERNS.some(pattern => pattern.test(entry.name))) {
      rmSync(child, { force: true })
      removed++
    }
  }
  return removed
}

/**
 * Directories a repaired package must not contribute.
 *
 * A repair copies a package from this workspace, where its development tree
 * still exists: `node_modules` (the deploy already hoisted every runtime
 * dependency to the closure root, so a package's own tree would duplicate it)
 * and the test suite. Left in, they are the difference between a closure of a
 * few hundred megabytes and one of two gigabytes.
 */
const REPAIR_EXCLUDED_DIRECTORIES = new Set(['node_modules', 'tests', '.git'])

/** Copy a workspace package into the closure without its development tree. */
function copyRepairedPackage(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: from => !REPAIR_EXCLUDED_DIRECTORIES.has(basename(from)),
  })
}

console.log(`build-closure: deploying ${manifest.name} to ${destination}`)
rmSync(destination, { recursive: true, force: true })
// A previous run's deploy (or its own) leaves the workspace install state where
// pnpm's deps-status check wants to purge node_modules and refuses to without a
// TTY. Restoring first is what makes this script runnable on its own rather than
// only after a manual reinstall.
run('pnpm', ['install', '--frozen-lockfile'])
run('pnpm', [
  '--filter', manifest.name, 'deploy',
  '--legacy', '--prod',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true',
  destination,
])

const declared = Object.keys(manifest.dependencies ?? {})
  .filter(name => name.startsWith('@deepseek-ai/'))
const present = () => new Set(readdirSync(scopeDir))
const index = workspaceIndex()

let repaired = 0
for (const name of declared) {
  const short = name.slice('@deepseek-ai/'.length)
  if (present().has(short)) continue
  const source = index.get(name)
  if (source === undefined) fail(`${name} is declared but neither deployed nor present in this workspace`)
  copyRepairedPackage(source, join(scopeDir, short))
  repaired++
}
if (repaired > 0) console.log(`build-closure: repaired ${String(repaired)} declared package(s) the deploy omitted`)

const materialized = (() => {
  let total = 0
  for (let pass = 0; pass < 6; pass++) {
    const replaced = materialize(join(destination, 'node_modules'))
    total += replaced
    if (replaced === 0) break
  }
  return total
})()
const links = findLinks(join(destination, 'node_modules'))
if (links.length > 0) fail(`${String(links.length)} symlink(s) remain, first: ${links[0]}`)

const thinned = prune(destination)

const missing = declared.filter(name => !present().has(name.slice('@deepseek-ai/'.length)))
if (missing.length > 0) fail(`closure is incomplete, missing: ${missing.join(', ')}`)

// ── pack: one compressed archive, expanded on first launch ──────────────────
//
// The installer's cost is file count, not bytes: Finder enumerates the whole
// bundle before it copies any of it, so a closure staged as loose files makes
// installation slow. It therefore ships as one archive, and the application
// expands it into the harness home before its first launch, where it is an
// ordinary package tree again — which is what lets a plugin installed at run
// time resolve the framework packages the host already has. Producer and
// consumer live together in `desktop/apps/shell`, so the format cannot drift.
//
// The materialized tree stays on disk: development runs point at it directly
// through `DSH_DESKTOP_CLOSURE`, and nothing needs an unpacking step.
const archive = join(dirname(destination), 'closure.tar.zst')
rmSync(archive, { force: true })
run('node', [join(repo, 'desktop/apps/shell/scripts/pack-closure.mjs'), destination, archive])
if (!existsSync(archive)) fail(`packing produced no archive at ${archive}`)
const packageCount = present().size
// The deploy above left the workspace's install state where pnpm's deps-status
// check wants to purge node_modules and refuses to without a TTY. Restoring it
// is what keeps this script runnable on its own.
run('pnpm', ['install', '--frozen-lockfile'])

console.log(
  `build-closure: ${String(packageCount)} scoped packages, ${String(materialized)} path(s) materialized, `
  + `${String(repaired)} repaired, 0 symlinks, ${String(thinned)} non-runtime file(s) pruned`,
)
console.log(
  `build-closure: packed to ${archive}; tree kept at ${destination} for development runs; `
  + `all ${String(declared.length)} declared dependencies present`,
)
