#!/usr/bin/env node
// The preload is CommonJS and hand-written, so it is copied rather than
// compiled: Electron loads it through its own require path, and giving it a
// TypeScript build would only add a step that produces the same bytes.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'preload.cjs')
const target = join(here, '..', 'lib', 'preload.cjs')
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`copy-preload: ${target}`)
