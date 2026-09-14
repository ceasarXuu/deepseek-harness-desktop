import { describe, expect, it } from 'vitest'
import {
  desktopBuildRecordFilename,
  desktopReleaseTag,
  desktopUpdateMetadataFilename,
  resolveDesktopAutoUpdateConfig,
  resolveDesktopAutoUpdateEnvironment,
  resolveDesktopAutoUpdateTarget,
  resolveDesktopUploadToken,
} from '../scripts/desktop-auto-update-environment.mjs'

const TEST_REPOSITORY = 'example/desktop-releases'

describe('desktop auto-update environment', () => {
  it('defaults packages and uploads to the test deployment repository', () => {
    expect(resolveDesktopAutoUpdateEnvironment({})).toBe('test')
    expect(resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_UPDATE_REPOSITORY: TEST_REPOSITORY,
    }, 'darwin', 'arm64', '1.2.3')).toEqual({
      environment: 'test',
      target: 'mac-arm64',
      owner: 'example',
      repo: 'desktop-releases',
      tag: 'v1.2.3',
      releaseType: 'release',
      metadataFilename: 'latest-mac.yml',
      publicUrl: 'https://github.com/example/desktop-releases/releases/download/v1.2.3/',
    })
  })

  it('publishes production releases to this repository', () => {
    expect(resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    }, 'win32', 'x64', '1.2.3-rc.4')).toEqual({
      environment: 'production',
      target: 'win-x64',
      owner: 'ceasarXuu',
      repo: 'deepseek-harness-desktop',
      tag: 'v1.2.3-rc.4',
      releaseType: 'prerelease',
      metadataFilename: 'rc.yml',
      publicUrl: 'https://github.com/ceasarXuu/deepseek-harness-desktop/releases/download/v1.2.3-rc.4/',
    })
  })

  it('requires the test repository and rejects malformed pairs', () => {
    expect(() => resolveDesktopAutoUpdateConfig({}, 'darwin', 'arm64', '1.2.3'))
      .toThrow(/DSH_DESKTOP_UPDATE_REPOSITORY/u)
    for (const repository of ['example', 'example/', '/desktop', 'example/desktop/extra', 'example/desk top']) {
      expect(() => resolveDesktopAutoUpdateConfig({
        DSH_DESKTOP_UPDATE_REPOSITORY: repository,
      }, 'darwin', 'arm64', '1.2.3')).toThrow(/owner\/repository pair/u)
    }
  })

  it('rejects a version that cannot name a release tag', () => {
    expect(() => resolveDesktopAutoUpdateConfig({
      DSH_DESKTOP_UPDATE_REPOSITORY: TEST_REPOSITORY,
    }, 'darwin', 'arm64', 'not-semver')).toThrow(/invalid Desktop version/u)
    expect(() => desktopReleaseTag('not-semver')).toThrow(/invalid Desktop version/u)
  })

  it('tags releases with the version the updater compares', () => {
    expect(desktopReleaseTag('1.2.3')).toBe('v1.2.3')
    expect(desktopReleaseTag('1.2.3-rc.4')).toBe('v1.2.3-rc.4')
  })

  it('reads the upload credential from either accepted variable', () => {
    expect(resolveDesktopUploadToken({ GH_TOKEN: 'workflow-token' })).toBe('workflow-token')
    expect(resolveDesktopUploadToken({ GITHUB_TOKEN: 'actions-token' })).toBe('actions-token')
    expect(resolveDesktopUploadToken({ GH_TOKEN: 'workflow-token', GITHUB_TOKEN: 'actions-token' }))
      .toBe('workflow-token')
    expect(() => resolveDesktopUploadToken({})).toThrow(/GH_TOKEN or GITHUB_TOKEN/u)
    expect(() => resolveDesktopUploadToken({ GITHUB_TOKEN: '   ' })).toThrow(/GH_TOKEN or GITHUB_TOKEN/u)
  })

  it('rejects unknown deployments and targets', () => {
    expect(() => resolveDesktopAutoUpdateEnvironment({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'staging',
    })).toThrow(/test.*production/u)
    expect(() => resolveDesktopAutoUpdateTarget('linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopBuildRecordFilename('linux-x64' as 'mac-arm64')).toThrow(/unsupported target/u)
  })

  it('matches electron-builder channel metadata names to the Desktop version', () => {
    expect(desktopUpdateMetadataFilename('1.2.3', 'darwin')).toBe('latest-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-alpha.4', 'darwin')).toBe('alpha-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-beta.2', 'win32')).toBe('beta.yml')
    expect(() => desktopUpdateMetadataFilename('not-semver', 'darwin')).toThrow(/invalid Desktop version/u)
    expect(() => desktopUpdateMetadataFilename('1.2.3', 'linux')).toThrow(/unsupported metadata platform/u)
  })
})
