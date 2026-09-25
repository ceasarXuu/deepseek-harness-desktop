/**
 * Suggest the next build version for a product version, so the sequence number
 * is derived rather than remembered.
 *
 * `apps/desktop/README.md` gives the form as `<product version>.<date>.<index>`
 * for a prerelease base and `<product version>-test.<date>.<index>` for a
 * stable one. What makes an index correct is which ones are taken, and this
 * fork reads them from the artifacts it produced, the only place it publishes a
 * test build to.
 */

import { readdir } from 'node:fs/promises'
import { parse } from 'semver'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import type { DesktopPackageTargetName } from './package-target.ts'

/** Artifact name electron-builder writes for one build, on either platform; unsigned Windows builds add a suffix. */
const ARTIFACT = /(?:^|\/)deepseek-harness-(?<version>.+)-(?:mac|win)-(?:arm64|x64)(?:-unsigned)?\.(?:exe|dmg|zip)$/u

/** Inputs that decide which versions are already taken. */
export interface DesktopBuildVersionSuggestionOptions {
  readonly productVersion: string
  readonly target: DesktopPackageTargetName
  readonly environment: NodeJS.ProcessEnv
  /** Date segment to number within; defaults to today where the build runs. */
  readonly date?: string
  /** Directory electron-builder writes installers into for this build. */
  readonly artifactsRoot: string
}

/**
 * Format a date as the convention's segment.
 * @param date - Date to format.
 * @returns The date as `YYYYMMDD` in the build host's own time zone.
 */
export function desktopBuildDateSegment(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${String(date.getFullYear())}${month}${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Read the sequence numbers already used for one product version and date.
 * @param versions - Versions found in a bucket or directory.
 * @param prefix - Everything a numbered build carries before its index.
 * @returns Every index present, unordered.
 */
function sequenceNumbers(versions: Iterable<string>, prefix: string): number[] {
  const numbers: number[] = []
  for (const version of versions) {
    if (!version.startsWith(prefix)) continue
    const index = version.slice(prefix.length)
    if (/^\d+$/u.test(index)) numbers.push(Number(index))
  }
  return numbers
}

/**
 * Read the versions one output directory already holds.
 * @param artifactsRoot - Directory electron-builder wrote installers into.
 * @returns Versions parsed from artifact names.
 */
async function localVersions(artifactsRoot: string): Promise<string[]> {
  const entries = await readdir(artifactsRoot).catch(() => [])
  return entries.map(entry => ARTIFACT.exec(entry)?.groups?.version)
    .filter((version): version is string => version !== undefined && parse(version) !== null)
}

/**
 * Read the versions already published for one target.
 *
 * This fork publishes to GitHub releases rather than an object store, and a release exposes no
 * prefix listing to page through, so numbering falls back to the local artifacts of this run.
 * @returns Undefined, so the caller numbers from the artifacts this run produced.
 */
function remoteVersions(): undefined {
  return undefined
}

/**
 * Suggest the next build version for today, numbering after what is already taken.
 * @param options - Product version, target, and environment to search.
 * @returns A validated build version whose index is free.
 */
export async function suggestDesktopBuildVersion(options: DesktopBuildVersionSuggestionOptions): Promise<string> {
  const prefix = `${desktopBuildVersionPrefix(options.productVersion)}${options.date ?? desktopBuildDateSegment()}.`
  const published = remoteVersions()
  const taken = published ?? await localVersions(options.artifactsRoot)
  const used = sequenceNumbers(taken, prefix)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  const suggestion = validateDesktopBuildVersion(`${prefix}${String(next)}`, options.productVersion)
  process.stdout.write(`desktop package: numbering ${suggestion} after ${String(used.length)} ${
    published === undefined ? 'local artifact' : 'published build'}${used.length === 1 ? '' : 's'} for ${prefix}*\n`)
  return suggestion
}
