import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

it('keeps disabled packages visible and offers recovery without a running backend', async () => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  let enabled = true
  let ready = false
  const disableAll = vi.fn(async () => { enabled = false; ready = true })
  const toggle = vi.fn(async (_name: string, active: boolean) => { enabled = active })
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    backend: { status: async () => ready ? { phase: 'ready' } : { phase: 'error', message: 'plugin requires Cordis ^2.0.0' }, retry: vi.fn() },
    plugins: { list: async () => [{ name: 'example-plugin', version: '1.0.0', enabled }], disableAll, toggle },
    bundles: { list: async () => [] },
    diagnostics: { get: async () => diagnosticsPayload(), reveal: vi.fn() },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
    expect(document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(false)
    expect(document.querySelector('#startup-error')?.textContent).toBe('plugin requires Cordis ^2.0.0')
    document.querySelector<HTMLButtonElement>('#disable-all')?.click()
    await expect.poll(() => document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(true)
    expect(disableAll).toHaveBeenCalledOnce()
    expect(document.querySelector('#plugins li')?.textContent).toMatchInlineSnapshot('"example-plugin1.0.0 · DisabledEnableUpdateRemove"')
    document.querySelector<HTMLButtonElement>('#plugins li button')?.click()
    await expect.poll(() => toggle.mock.calls).toEqual([['example-plugin', true]])
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toBe('example-plugin1.0.0DisableUpdateRemove')
  } finally { dom.window.close() }
})

it('renders the diagnostics section and copies the block it fetched', async () => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  const writeText = vi.fn(async () => {})
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true })
  const reveal = vi.fn(async () => {})
  const payload = diagnosticsPayload()
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    backend: { status: async () => ({ phase: 'ready' }), retry: vi.fn() },
    plugins: { list: async () => [], disableAll: vi.fn(), toggle: vi.fn() },
    bundles: { list: async () => [] },
    diagnostics: { get: async () => payload, reveal },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelectorAll('#diagnostics li').length).toBe(5)
    expect(document.querySelector('#diagnostics-heading')?.textContent).toBe('Diagnostics')
    expect([...document.querySelectorAll('#diagnostics li')].map(item => item.textContent)).toEqual([
      'Application1.2.3',
      'dsh runtime1.2.3',
      'Harness home/home/user/.dsh',
      'Runtime location/home/user/.dsh/closure/1.2.3',
      'Last startFailed — plugin composition failed',
    ])
    document.querySelector<HTMLButtonElement>('#diagnostics-copy')?.click()
    await expect.poll(() => writeText.mock.calls).toEqual([[payload.block]])
    await expect.poll(() => document.querySelector('#status')?.textContent).toBe('Diagnostics copied to the clipboard.')
    document.querySelector<HTMLButtonElement>('#diagnostics-reveal')?.click()
    await expect.poll(() => reveal.mock.calls).toEqual([[]])
    await expect.poll(() => document.querySelector('#status')?.textContent).toBe('Opened the Harness home in the file manager.')
  } finally { dom.window.close() }
})

function diagnosticsPayload() {
  return {
    applicationVersion: '1.2.3',
    dshVersion: '1.2.3',
    harnessHome: '/home/user/.dsh',
    runtimeLocation: '/home/user/.dsh/closure/1.2.3',
    startupFailed: true,
    startupFailure: 'plugin composition failed',
    block: 'Application: 1.2.3\ndsh runtime: 1.2.3\nHarness home: /home/user/.dsh\nRuntime location: /home/user/.dsh/closure/1.2.3\nLast start: Failed — plugin composition failed',
  }
}
