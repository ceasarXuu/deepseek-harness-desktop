import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMacOSAppUpdateConfig,
  resolveMacOSAppUpdateFeed,
  verifyMacOSAppUpdateConfig,
  writeMacOSAppUpdateConfig,
} from '../scripts/macos-app-update-config.mjs'

const roots: string[] = []
const update = { owner: 'example', repo: 'desktop-releases', releaseType: 'prerelease' } as const

async function fixture(): Promise<{ appPath: string; resourcesDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-macos-update-config-'))
  roots.push(root)
  const appPath = join(root, 'DeepSeek Harness.app')
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  await mkdir(resourcesDir, { recursive: true })
  return { appPath, resourcesDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('macOS packaged updater configuration', () => {
  it('uses the GitHub release published for the build', () => {
    expect(resolveMacOSAppUpdateFeed([{ provider: 'github', ...update }])).toEqual(update)
    for (const publish of [undefined, [], [{ provider: 'generic', url: 'https://example.com/' }],
      [{ provider: 'github', owner: 'example', repo: 'desktop-releases' }]]) {
      expect(() => resolveMacOSAppUpdateFeed(publish)).toThrow(/macOS update config/u)
    }
  })

  it('writes and verifies the release repository before signing', async () => {
    const paths = await fixture()
    expect(createMacOSAppUpdateConfig(update, 'deepseek-harness-updater')).toEqual({
      provider: 'github',
      owner: 'example',
      repo: 'desktop-releases',
      releaseType: 'prerelease',
      updaterCacheDirName: 'deepseek-harness-updater',
    })
    await writeMacOSAppUpdateConfig(paths.resourcesDir, update, 'deepseek-harness-updater')
    await expect(verifyMacOSAppUpdateConfig(paths.appPath, update, 'deepseek-harness-updater')).resolves.toBeUndefined()
  })

  it.each([
    ['missing', undefined],
    ['wrong repository', 'provider: github\nowner: other\nrepo: desktop-releases\nreleaseType: prerelease\nupdaterCacheDirName: fixture\n'],
    ['wrong release type', 'provider: github\nowner: example\nrepo: desktop-releases\nreleaseType: release\nupdaterCacheDirName: fixture\n'],
    ['missing cache directory', 'provider: github\nowner: example\nrepo: desktop-releases\nreleaseType: prerelease\n'],
  ] as const)('rejects %s updater configuration', async (_label, contents) => {
    const paths = await fixture()
    if (contents !== undefined) await writeFile(join(paths.resourcesDir, 'app-update.yml'), contents)
    await expect(verifyMacOSAppUpdateConfig(paths.appPath, update)).rejects.toThrow(/macOS update config/u)
  })

  it('rejects another updater cache directory when the signed value is known', async () => {
    const paths = await fixture()
    await writeMacOSAppUpdateConfig(paths.resourcesDir, update, 'wrong-updater')
    await expect(verifyMacOSAppUpdateConfig(paths.appPath, update, 'deepseek-harness-updater'))
      .rejects.toThrow(/expected deepseek-harness-updater/u)
  })
})
