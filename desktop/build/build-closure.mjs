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
import { dirname, join, resolve } from 'node:path'
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

console.log(`build-closure: deploying ${manifest.name} to ${destination}`)
rmSync(destination, { recursive: true, force: true })
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
  cpSync(source, join(scopeDir, short), { recursive: true, dereference: true, force: true })
  repaired++
}
if (repaired > 0) console.log(`build-closure: repaired ${String(repaired)} declared package(s) the deploy omitted`)

// Copying a symlinked directory can surface links nested inside its contents, so
// the pass repeats until the tree is link-free rather than assuming one sweep
// reaches every depth.
let materialized = 0
for (let pass = 0; pass < 6; pass++) {
  const replaced = materialize(join(destination, 'node_modules'))
  materialized += replaced
  if (replaced === 0) break
}
const links = findLinks(join(destination, 'node_modules'))
if (links.length > 0) fail(`${String(links.length)} symlink(s) remain, first: ${links[0]}`)

const missing = declared.filter(name => !present().has(name.slice('@deepseek-ai/'.length)))
if (missing.length > 0) fail(`closure is incomplete, missing: ${missing.join(', ')}`)

console.log(
  `build-closure: ${String(present().size)} scoped packages, ${String(materialized)} path(s) materialized, `
  + `${String(repaired)} repaired, 0 symlinks, all ${String(declared.length)} declared dependencies present`,
)
