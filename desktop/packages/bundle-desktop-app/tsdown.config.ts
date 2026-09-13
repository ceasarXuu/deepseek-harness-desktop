import { defineConfig } from 'tsdown'

/**
 * Two entries, each self-contained: the bundle plugin the composition mounts,
 * and the packaged harness entry the shell spawns. The root build emits only
 * `{index,invariant,startup}`, so this override names what this package
 * actually ships. `entry` disables code splitting because it is spawned as a
 * bare file path from inside the closure and cannot share chunks with siblings.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
  {
    entry: ['lib/types/entry.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
])
