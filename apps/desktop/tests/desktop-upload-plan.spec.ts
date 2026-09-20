import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { desktopUpdateMetadataFilename } from '../scripts/desktop-auto-update-environment.mjs'
import type { DesktopPackageTargetName } from '../scripts/package-target.ts'

const temporaryDirectories: string[] = []
const TEST_REPOSITORY = 'example/desktop-releases'
const require = createRequire(import.meta.url)
const { createBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder.js') as {
  createBlockmap: (file: string, target: object, packager: { info: { emitArtifactBuildCompleted(event: object): Promise<void> } },
    safeArtifactName: string) => Promise<{ size: number; sha512: string }>
}

interface Fixture {
  readonly repositoryRoot: string
  readonly appRoot: string
  readonly artifactsRoot: string
  readonly environment: NodeJS.ProcessEnv
}

function digest(contents: string): string {
  return createHash('sha512').update(contents).digest('base64')
}

function releasePublicUrl(tag: string, environment: 'test' | 'production'): string {
  const repository = environment === 'test' ? TEST_REPOSITORY : 'ceasarXuu/deepseek-harness-desktop'
  return `https://github.com/${repository}/releases/download/${tag}/`
}

async function fixture(
  target: DesktopPackageTargetName,
  version = '1.2.3',
  environment: 'test' | 'production' = 'test',
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-upload-'))
  temporaryDirectories.push(root)
  const repositoryRoot = join(root, 'repository')
  const appRoot = join(repositoryRoot, 'apps', 'desktop')
  const artifactsRoot = join(appRoot, '.desktop-build', 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  await writeFile(join(repositoryRoot, 'package.json'), `${JSON.stringify({ version })}\n`)
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({ version })}\n`)

  const [os, arch] = target.split('-') as ['mac' | 'win', 'arm64' | 'x64']
  const base = `deepseek-harness-${version}-${os}-${arch}`
  const tag = `v${version}`
  await writeFile(join(artifactsRoot, `${target}-release.json`), `${JSON.stringify({
    schemaVersion: 1,
    target,
    version,
    environment,
    tag,
    releaseType: version.includes('-') ? 'prerelease' : 'release',
    publicUrl: releasePublicUrl(tag, environment),
  })}\n`)

  if (os === 'mac') {
    const zip = 'signed macOS ZIP fixture'
    await writeFile(join(artifactsRoot, `${base}.zip`), zip)
    await writeFile(join(artifactsRoot, `${base}.zip.blockmap`), 'blockmap')
    await writeFile(join(artifactsRoot, `${base}.dmg`), 'notarized DMG fixture')
    await writeFile(join(artifactsRoot, desktopUpdateMetadataFilename(version, 'darwin')), `${JSON.stringify({
      version,
      files: [{ url: `${base}.zip`, size: Buffer.byteLength(zip), sha512: digest(zip) }],
    })}\n`)
  }
  else {
    const executable = 'signed NSIS executable fixture'
    await writeFile(join(artifactsRoot, `${base}.exe`), executable)
    const info = await createBlockmap(join(artifactsRoot, `${base}.exe`), {},
      { info: { emitArtifactBuildCompleted: async () => {} } }, `${base}.exe`)
    expect(Object.hasOwn(info, 'blockMapSize')).toBe(false)
    await writeFile(join(artifactsRoot, `${base}.exe.blockmap`), 'blockmap')
    await writeFile(join(artifactsRoot, desktopUpdateMetadataFilename(version, 'win32')), `${JSON.stringify({
      version,
      files: [{
        url: `${base}.exe`,
        ...info,
        blockMapSize: Buffer.byteLength('blockmap'),
      }],
    })}\n`)
  }
  return {
    repositoryRoot,
    appRoot,
    artifactsRoot,
    environment: environment === 'test'
      ? {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
        DSH_DESKTOP_UPDATE_REPOSITORY: TEST_REPOSITORY,
      }
      : { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('desktop upload plan', () => {
  it('validates macOS artifacts against the channel file and uploads no channel metadata', async () => {
    const paths = await fixture('mac-arm64')
    const plan = await createDesktopUploadPlan('mac-arm64', paths)
    expect(plan).toMatchObject({
      environment: 'test',
      version: '1.2.3',
      owner: 'example',
      repo: 'desktop-releases',
      tag: 'v1.2.3',
      releaseType: 'release',
      publicUrl: `https://github.com/${TEST_REPOSITORY}/releases/download/v1.2.3/`,
    })
    expect(plan.assets.map(asset => asset.filename)).toEqual([
      'deepseek-harness-1.2.3-mac-arm64.dmg',
      'deepseek-harness-1.2.3-mac-arm64.zip',
      'deepseek-harness-1.2.3-mac-arm64.zip.blockmap',
    ])
    expect(plan.assets.every(asset => !asset.channelMetadata)).toBe(true)
  })

  it('derives the prerelease channel filename from the version', async () => {
    const paths = await fixture('mac-arm64', '1.2.3-alpha.4')
    const plan = await createDesktopUploadPlan('mac-arm64', paths)
    expect(plan.assets.map(asset => asset.filename)).toEqual([
      'deepseek-harness-1.2.3-alpha.4-mac-arm64.dmg',
      'deepseek-harness-1.2.3-alpha.4-mac-arm64.zip',
      'deepseek-harness-1.2.3-alpha.4-mac-arm64.zip.blockmap',
    ])
    expect(plan.releaseType).toBe('prerelease')
    expect(plan.tag).toBe('v1.2.3-alpha.4')
  })

  it('validates the Windows installer with its external blockmap and uploads metadata last', async () => {
    const paths = await fixture('win-x64', '2.0.0', 'production')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    expect(plan.assets.map(asset => asset.filename)).toEqual([
      'deepseek-harness-2.0.0-win-x64.exe',
      'deepseek-harness-2.0.0-win-x64.exe.blockmap',
      'latest.yml',
    ])
    expect(plan).toMatchObject({
      publicUrl: 'https://github.com/ceasarXuu/deepseek-harness-desktop/releases/download/v2.0.0/',
    })
    expect(plan.assets.at(-1)).toMatchObject({ channelMetadata: true })
  })

  it.each(['missing', 'empty'])('rejects a %s Windows blockmap before publishing its feed', async (condition) => {
    const paths = await fixture('win-x64')
    const path = join(paths.artifactsRoot, 'deepseek-harness-1.2.3-win-x64.exe.blockmap')
    if (condition === 'missing') await rm(path)
    else await writeFile(path, '')
    await expect(createDesktopUploadPlan('win-x64', paths)).rejects.toThrow(/missing or empty artifact.*\.exe\.blockmap/u)
  })

  it('rejects a completed build from another dsh version or deployment', async () => {
    const paths = await fixture('mac-x64')
    await writeFile(join(paths.repositoryRoot, 'package.json'), '{"version":"1.2.4"}\n')
    await writeFile(join(paths.appRoot, 'package.json'), '{"version":"1.2.4"}\n')
    await expect(createDesktopUploadPlan('mac-x64', paths)).rejects.toThrow(/completion record.*1\.2\.4/u)

    const productionPaths = await fixture('mac-x64', '1.2.3', 'production')
    await expect(createDesktopUploadPlan('mac-x64', {
      ...productionPaths,
      environment: {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
        DSH_DESKTOP_UPDATE_REPOSITORY: TEST_REPOSITORY,
      },
    })).rejects.toThrow(/completion record.*test/u)
  })

  it('rejects stale architecture metadata and modified updater bytes', async () => {
    const paths = await fixture('mac-arm64')
    const metadataPath = join(paths.artifactsRoot, 'latest-mac.yml')
    const zipPath = join(paths.artifactsRoot, 'deepseek-harness-1.2.3-mac-arm64.zip')
    await writeFile(zipPath, 'modified')
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/size.*metadata/u)

    const x64 = 'wrong architecture'
    await writeFile(metadataPath, `${JSON.stringify({
      version: '1.2.3',
      files: [{
        url: 'deepseek-harness-1.2.3-mac-x64.zip',
        size: Buffer.byteLength(x64),
        sha512: digest(x64),
      }],
    })}\n`)
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/mac-arm64\.zip/u)
  })
})
