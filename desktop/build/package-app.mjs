#!/usr/bin/env node
/**
 * Build the distributable desktop application.
 *
 * Three steps, in the order their outputs depend on each other: the harness
 * closure the application carries, the Electron shell that supervises it, and
 * the electron-builder packaging that combines them into a DMG and the ZIP the
 * updater consumes.
 *
 * Signing comes from the build machine's keychain, which electron-builder finds
 * on its own. Notarization needs credentials that may not exist on a development
 * machine, so it is opt-in through `DSH_DESKTOP_NOTARIZE=1`; a signed but
 * un-notarized artifact installs where it is accepted explicitly, which is what
 * a local build is for. The release workflow sets it.
 *
 * Usage: node desktop/build/package-app.mjs [--skip-closure] [--arch arm64]
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shellDir = join(repo, 'desktop/apps/shell')
const outputDir = join(repo, 'desktop/build/out')
const closureArchive = join(outputDir, 'harness.asar')
const skipClosure = process.argv.includes('--skip-closure')
const archIndex = process.argv.indexOf('--arch')
const arch = archIndex === -1 ? 'arm64' : (process.argv[archIndex + 1] ?? 'arm64')

// `pnpm deploy` perturbs the workspace's install state, and every later `pnpm run`
// then meets a deps-status check that wants to purge node_modules. pnpm refuses
// to purge without a TTY unless told to, so this pipeline — which is non-interactive
// by construction — answers that question once for all of its child processes.
process.env['npm_config_confirm_modules_purge'] = 'false'

function run(command, args, cwd) {
  console.log(`package-app: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`package-app: ${command} failed with status ${String(result.status)}`)
    process.exit(1)
  }
}

if (!skipClosure) {
  run('node', [join(repo, 'desktop/build/build-closure.mjs')], repo)
} else if (!existsSync(closureArchive)) {
  console.error(`package-app: --skip-closure given but no closure archive exists at ${closureArchive}`)
  process.exit(1)
}

// `pnpm deploy` — and, on a rerun, whatever the previous invocation left behind —
// puts the workspace's install state where the next `pnpm run` meets a
// deps-status check that wants to purge node_modules and cannot ask. Restoring
// it here is what keeps this pipeline runnable end to end rather than dependent
// on a manual reinstall between steps.
run('pnpm', ['install', '--frozen-lockfile'], repo)

run('pnpm', ['--filter', '@deepseek-ai/dsh-desktop-shell', 'run', 'build'], repo)

const notarize = process.env['DSH_DESKTOP_NOTARIZE'] === '1'
run('pnpm', [
  '--filter', '@deepseek-ai/dsh-desktop-shell', 'exec', 'electron-builder',
  '--mac', `--${arch}`,
  `--config.mac.notarize=${String(notarize)}`,
], repo)

console.log(`package-app: notarization ${notarize ? 'enabled' : 'skipped (DSH_DESKTOP_NOTARIZE=1 to enable)'}`)
console.log(`package-app: artifacts in ${join(shellDir, 'dist')}`)
