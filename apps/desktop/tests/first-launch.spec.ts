import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIRST_LAUNCH_GUIDE_FILE,
  firstLaunchGuidePath,
  readFirstLaunchGuideAcknowledged,
  shouldShowFirstLaunchGuide,
  writeFirstLaunchGuideAcknowledged,
} from '../src/first-launch.ts'

const temporaryDirectories: string[] = []

async function desktopRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-desktop-first-launch-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, { recursive: true, force: true })))
})

describe('first-launch guide decision', () => {
  it('offers the guide only for a new profile that has not opted out', () => {
    expect(shouldShowFirstLaunchGuide({ profileExisted: false, acknowledged: false })).toBe(true)
    expect(shouldShowFirstLaunchGuide({ profileExisted: true, acknowledged: false })).toBe(false)
    expect(shouldShowFirstLaunchGuide({ profileExisted: false, acknowledged: true })).toBe(false)
    expect(shouldShowFirstLaunchGuide({ profileExisted: true, acknowledged: true })).toBe(false)
  })
})

describe('first-launch acknowledgement record', () => {
  it('places the record in the Electron-owned desktop directory', async () => {
    const root = await desktopRoot()
    expect(firstLaunchGuidePath(root)).toBe(join(root, FIRST_LAUNCH_GUIDE_FILE))
  })

  it('reads a missing record as not acknowledged', async () => {
    const root = await desktopRoot()
    expect(readFirstLaunchGuideAcknowledged(root)).toBe(false)
  })

  it('persists the choice atomically and reads it back', async () => {
    const root = await desktopRoot()
    writeFirstLaunchGuideAcknowledged(root)
    expect(readFirstLaunchGuideAcknowledged(root)).toBe(true)
    const path = firstLaunchGuidePath(root)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ acknowledged: true })
    // The temporary sibling is renamed into place, never left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('treats an unreadable record as not acknowledged', async () => {
    const root = await desktopRoot()
    await writeFile(firstLaunchGuidePath(root), 'not json')
    expect(readFirstLaunchGuideAcknowledged(root)).toBe(false)
  })
})
