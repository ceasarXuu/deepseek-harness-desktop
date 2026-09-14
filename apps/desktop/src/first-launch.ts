/** First-launch guide decision and its Electron-owned acknowledgement record. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Small record written under `$DSH_HOME/desktop` when the user opts out of the guide. */
export const FIRST_LAUNCH_GUIDE_FILE = 'first-launch-guide.json'

/** Facts that decide whether this launch offers the first-launch guide. */
export interface FirstLaunchGuideState {
  /** Whether the Desktop profile already existed when this launch began. */
  readonly profileExisted: boolean
  /** Whether the user previously chose not to see the guide again. */
  readonly acknowledged: boolean
}

/**
 * Decide whether this launch offers the first-launch guide.
 *
 * The guide is for the first start of an installed application, so a launch that
 * began with an existing profile never offers it. The persisted choice keeps it
 * from returning after the profile is reset, which deletes the profile but not
 * the Electron-owned state beside it.
 * @param state - Profile presence and the persisted choice.
 * @returns True when the guide should be shown once the workspace opens.
 */
export function shouldShowFirstLaunchGuide(state: FirstLaunchGuideState): boolean {
  return !state.profileExisted && !state.acknowledged
}

/**
 * Path of the acknowledgement record under the Electron-owned desktop directory.
 * @param desktopRoot - `$DSH_HOME/desktop`.
 * @returns Absolute path of the small JSON record.
 */
export function firstLaunchGuidePath(desktopRoot: string): string {
  return join(desktopRoot, FIRST_LAUNCH_GUIDE_FILE)
}

/**
 * Read the persisted choice; a missing or unreadable record counts as not acknowledged.
 * @param desktopRoot - `$DSH_HOME/desktop`.
 * @returns Whether the user chose not to see the guide again.
 */
export function readFirstLaunchGuideAcknowledged(desktopRoot: string): boolean {
  const path = firstLaunchGuidePath(desktopRoot)
  if (!existsSync(path)) return false
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof value === 'object' && value !== null && (value as { acknowledged?: unknown }).acknowledged === true
  } catch {
    // A corrupt record is treated as absent: showing the guide again is harmless,
    // while trusting a half-written file is not.
    return false
  }
}

/**
 * Record the user's choice to stop showing the guide, replacing the record atomically.
 * @param desktopRoot - `$DSH_HOME/desktop`.
 */
export function writeFirstLaunchGuideAcknowledged(desktopRoot: string): void {
  const path = firstLaunchGuidePath(desktopRoot)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ acknowledged: true }, undefined, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}
