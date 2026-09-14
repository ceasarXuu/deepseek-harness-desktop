/** Upload one validated Desktop release to its GitHub release. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { DesktopPackageTargetName } from './package-target.ts'
import { resolveDesktopUploadToken } from './desktop-auto-update-environment.mjs'
import { createDesktopUploadPlan } from './desktop-upload-plan.ts'
import {
  ensureRelease,
  uploadReleaseAsset,
  type GitHubReleaseClient,
} from './github-release-client.ts'

const SUPPORTED_TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])

function targetName(value: string): DesktopPackageTargetName {
  if (!SUPPORTED_TARGETS.has(value as DesktopPackageTargetName)) {
    throw new Error(`desktop upload: unsupported target ${JSON.stringify(value)}; expected ${[...SUPPORTED_TARGETS].join(', ')}`)
  }
  return value as DesktopPackageTargetName
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1) {
    throw new Error('desktop upload: expected exactly one target')
  }
  const plan = await createDesktopUploadPlan(targetName(target))
  const client: GitHubReleaseClient = {
    token: resolveDesktopUploadToken(process.env),
    owner: plan.owner,
    repo: plan.repo,
  }
  process.stdout.write(`desktop upload: ${plan.target} ${plan.version} -> ${plan.publicUrl}\n`)
  const release = await ensureRelease(client, plan.tag, plan.releaseType === 'prerelease')
  for (const asset of plan.assets) {
    await uploadReleaseAsset(client, release.id, {
      path: asset.path,
      filename: asset.filename,
      contentType: asset.contentType,
    })
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
