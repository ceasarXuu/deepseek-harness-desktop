#!/usr/bin/env node
/**
 * Pack a materialized closure into the one archive the application carries.
 *
 * The consumer of this format is `src/closure.ts` in the same package, so the
 * two are changed together: one zstd-compressed tar, with POSIX modes intact,
 * because the executables inside it (ripgrep, node-pty's spawn-helper) stop
 * being runnable the moment an archive stops preserving them.
 *
 * Usage: node scripts/pack-closure.mjs <closure-directory> <archive-path>
 */
import { createWriteStream, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import * as tar from 'tar'

const [directory, archive] = process.argv.slice(2)
if (directory === undefined || archive === undefined) {
  console.error('pack-closure: usage: node scripts/pack-closure.mjs <closure-directory> <archive-path>')
  process.exit(2)
}

let entries = 0
await pipeline(
  tar.c({
    cwd: directory,
    // Absolute paths, ownership, and the source machine's times are noise for a
    // tree that is extracted into a fresh location on the user's machine.
    portable: true,
    // Modes are not noise: they decide whether the closure's own executables run.
    noChmod: false,
    // The filter sees every path that would enter the archive; counting here
    // reports the same number the extractor will count on the other side.
    filter: () => { entries += 1; return true },
  }, ['.']),
  createZstdCompress(),
  createWriteStream(archive),
)

const bytes = statSync(archive).size
console.log(`pack-closure: ${String(entries)} entries -> ${archive} (${(bytes / 1_048_576).toFixed(1)} MB)`)
