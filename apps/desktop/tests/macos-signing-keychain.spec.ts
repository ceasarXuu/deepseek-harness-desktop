import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseSigningIdentities, withMacOSSigningKeychain } from '../scripts/macos-signing-keychain.mjs'

const HASH = 'F645A27E30426034C222868CDF1295B085E9F978'
const OTHER_HASH = 'BA991F5FAF431B710373A65218EA860A7E21138C'
const CERTIFICATE_NAME = 'Developer ID Application: Example (TEAMID1234)'
const environment = { CSC_LINK: '/signing.p12', CSC_KEY_PASSWORD: 'export-secret', DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example (TEAMID1234)' }

function listing(identities: readonly { hash: string; name: string }[]): string {
  return `${identities.map((entry, index) => `  ${index + 1}) ${entry.hash} "${entry.name}"`).join('\n')}\n     ${identities.length} valid identities found\n`
}

/** Executor whose owned keychain reports the given identities. */
function executor(identities: readonly { hash: string; name: string }[] = [{ hash: HASH, name: CERTIFICATE_NAME }], failAt?: string) {
  return vi.fn((command: string, args: string[]) => {
    if (failAt !== undefined && args[0] === failAt) throw Error('tool failure')
    if (command === '/usr/bin/security' && args[0] === 'find-identity') return listing(identities)
    return ''
  })
}

describe('temporary macOS signing identity', () => {
  it('scopes signing to the imported identity and removes credentials before invoking the build', async () => {
    const run = executor()
    let keychain = ''
    await withMacOSSigningKeychain(environment, async (env) => {
      keychain = env.CSC_KEYCHAIN!
      expect(existsSync(dirname(keychain))).toBe(true)
      expect(env.CSC_LINK).toBeUndefined()
      expect(env.CSC_KEY_PASSWORD).toBeUndefined()
      expect(run.mock.calls.some(([command, args]) => command === '/usr/bin/codesign' && args.includes(keychain))).toBe(true)
      expect(run.mock.calls.at(-1)?.[1]).toContain('--verify')
    }, run)
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['delete-keychain', keychain])
    expect(existsSync(dirname(keychain))).toBe(false)
    expect(environment.CSC_KEY_PASSWORD).toBe('export-secret')
    const create = run.mock.calls.find(([, args]) => args[0] === 'create-keychain')![1]
    const partition = run.mock.calls.find(([, args]) => args[0] === 'set-partition-list' || args[0] === 'set-key-partition-list')![1]
    expect(partition[partition.indexOf('-k') + 1]).toBe(create[2])
    expect(create[2]).not.toBe(environment.CSC_KEY_PASSWORD)
  })

  it.each([
    'Example (TEAMID1234)',
    'Developer ID Application: Example (TEAMID1234)',
    ' Developer ID Application: Example (TEAMID1234) ',
  ])('probes the imported identity hash for the configured identity %s', async (identity) => {
    const run = executor()
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    try {
      await withMacOSSigningKeychain({ ...environment, DSH_DESKTOP_MACOS_SIGNING_IDENTITY: identity }, async () => {}, run)
    }
    finally { write.mockRestore() }
    const probe = run.mock.calls.find(([command, args]) => command === '/usr/bin/codesign' && args[0] === '--force')![1]
    expect(probe[probe.indexOf('--sign') + 1]).toBe(HASH)
    expect(written.join('')).toContain('equal: true')
  })

  it.each([
    ['none', []],
    ['two', [{ hash: HASH, name: CERTIFICATE_NAME }, { hash: OTHER_HASH, name: 'Developer ID Application: Other (TEAMID1234)' }]],
  ] as const)('refuses a keychain holding %s code-signing identity', async (_label, identities) => {
    await expect(withMacOSSigningKeychain(environment, async () => {}, executor(identities)))
      .rejects.toThrow(/exactly one is required/u)
  })

  it('refuses to probe without a configured signing identity', async () => {
    await expect(withMacOSSigningKeychain({ CSC_LINK: '/signing.p12', CSC_KEY_PASSWORD: 'export-secret' }, async () => {}, () => {}))
      .rejects.toThrow(/DSH_DESKTOP_MACOS_SIGNING_IDENTITY/u)
  })

  it('reads identities out of a security listing and ignores its summary', () => {
    expect(parseSigningIdentities(listing([{ hash: HASH, name: CERTIFICATE_NAME }]))).toEqual([{ hash: HASH, name: CERTIFICATE_NAME }])
    expect(parseSigningIdentities('     0 valid identities found\n')).toEqual([])
  })

  it.each(['import', '--force', 'build'])('cleans up and prevents subsequent work after %s fails', async (stage) => {
    const action = vi.fn(async () => { if (stage === 'build') throw Error('build failure') })
    const run = executor(undefined, stage)
    await expect(withMacOSSigningKeychain(environment, action, run)).rejects.toThrow(/failure/u)
    const keychain = run.mock.calls[0]![1].at(-1)!
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['delete-keychain', keychain])
    expect(existsSync(dirname(keychain))).toBe(false)
    expect(action).toHaveBeenCalledTimes(stage === 'build' ? 1 : 0)
  })

  it('allocates distinct keychains for overlapping invocations', async () => {
    const paths: string[] = []
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => { release = resolve })
    const action = async (env: NodeJS.ProcessEnv) => {
      paths.push(env.CSC_KEYCHAIN!)
      if (paths.length === 2) release()
      await bothReady
      expect(paths.every(path => existsSync(dirname(path)))).toBe(true)
    }
    await Promise.all([
      withMacOSSigningKeychain(environment, action, executor()),
      withMacOSSigningKeychain(environment, action, executor()),
    ])
    expect(new Set(paths).size).toBe(2)
    expect(paths.every(path => !existsSync(dirname(path)))).toBe(true)
  })
})
