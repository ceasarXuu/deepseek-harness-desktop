import { defineConfig } from 'tsdown'

/**
 * One entry, self-contained: the store plugin the desktop composition mounts.
 * The root build's default entries are `{index,invariant,startup}`, and this
 * package ships no invariant module of its own.
 */
export default defineConfig({
  entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
})
