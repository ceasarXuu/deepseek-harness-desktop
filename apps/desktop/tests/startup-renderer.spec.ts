import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopBackendState } from '../src/backend-controller.ts'
import type { DshDesktopStartupApi } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import { startupFailureDocument } from '../src/startup-document.ts'

function startup(locale = 'en', status: Promise<DesktopBackendState> = Promise.resolve({ phase: 'starting' })) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/startup.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  onTestFinished(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    dom.window.close()
  })
  const listeners = new Set<(state: DesktopBackendState) => void>()
  const unsubscribe = vi.fn(() => { listeners.clear() })
  const disablePlugins = vi.fn(async () => {})
  const resetConfiguration = vi.fn(async () => {})
  const restart = vi.fn(async () => {})
  const queried = Promise.withResolvers<undefined>()
  const api: DshDesktopStartupApi = {
    protocolVersion: 1,
    locale: async () => resolveDesktopLocale(locale),
    backend: {
      status: () => { queried.resolve(undefined); return status },
      subscribe: (listener) => { listeners.add(listener); return unsubscribe },
    },
    disablePlugins, resetConfiguration, restart,
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  runInContext(readFileSync(new URL('../renderer/startup.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const document = dom.window.document
  const element = (selector: string): HTMLElement => {
    const result = document.querySelector<HTMLElement>(selector)
    if (result === null) throw new Error(`Missing startup element: ${selector}`)
    return result
  }
  const button = (selector: string): HTMLButtonElement => {
    const result = document.querySelector<HTMLButtonElement>(selector)
    if (result === null) throw new Error(`Missing startup button: ${selector}`)
    return result
  }
  const publish = (state: DesktopBackendState): void => { for (const listener of listeners) listener(state) }
  const copy = (): string => [element('#title').textContent, element('#description').textContent,
    ...['#disable-advice', '#reset-advice', '#reinstall-advice', '#recovery-status', '#error', '#actions']
      .filter(selector => !element(selector).hidden)
      .flatMap(selector => selector === '#actions'
        ? [...document.querySelectorAll<HTMLButtonElement>('#actions button')].filter(button => !button.hidden).map(button => button.textContent)
        : [element(selector).textContent]),
  ].join('\n')
  return { dom, document, element, button, publish, copy,
    disablePlugins, resetConfiguration, restart, unsubscribe, queried: queried.promise }
}

it('shows English loading and recovery actions without a Host document', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.copy()).toMatchInlineSnapshot(`
    "Starting DeepSeek Harness…
    Your workspace will open when it is ready."
  `)
  expect(page.element('main').getAttribute('aria-busy')).toBe('true')
  expect(page.element('#spinner').hidden).toBe(false)
  expect(page.element('#actions').hidden).toBe(true)
  expect(page.button('#restart').disabled).toBe(true)
  expect(page.button('#disable-plugins').disabled).toBe(true)
  page.publish({ phase: 'error', profileRecovery: true, message: 'Plugin failed to load' })
  expect(page.copy()).toMatchInlineSnapshot(`
    "DeepSeek Harness could not start
    DeepSeek Harness could not open your workspace. Choose a recovery action below: each one stops the current attempt and retries startup.
    Disabling third-party plugins keeps their files and starts DeepSeek Harness without them. Enable them again later from the Desktop Plugins window.
    Reset Desktop deletes all Desktop configuration and third-party plugins without a backup, then starts a fresh profile. Shared tasks and settings are kept.
    If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.
    Plugin failed to load
    Close and restart
    Disable all third-party plugins and retry
    Reset Desktop and retry"
  `)
  expect(page.element('main').getAttribute('aria-busy')).toBe('false')
  expect(page.element('#spinner').hidden).toBe(true)
  page.button('#restart').click()
  expect(page.restart).toHaveBeenCalledOnce()
  expect(page.element('#actions').hidden).toBe(false)
  expect(page.button('#restart').disabled).toBe(true)
  expect(page.element('#recovery-status').hidden).toBe(false)
  expect(page.element('#recovery-status').textContent).toBe('Running the recovery action…')
  expect(page.element('main').getAttribute('aria-busy')).toBe('true')
})

it.each([
  ['en', 'Preparing the bundled runtime…', 'Your workspace will open when it is ready.'],
  ['zh-CN', '正在准备内置运行时…', '准备就绪后将自动打开工作区。'],
])('shows determinate runtime progress while the first launch expands the archive (%s)', async (locale, expanding, loading) => {
  const page = startup(locale)
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.element('#progress').hidden).toBe(true)
  page.publish({ phase: 'starting', runtime: { stage: 'expanding', done: 25, total: 100 } })
  expect(page.element('#description').textContent).toBe(expanding)
  expect(page.element('#progress').hidden).toBe(false)
  expect(page.element('#progress').getAttribute('aria-valuenow')).toBe('25')
  expect(page.element('#progress-bar').style.width).toBe('25%')
  expect(page.element('#spinner').hidden).toBe(false)
  // The final digest pass reports no counts of its own, so the bar holds at completion.
  page.publish({ phase: 'starting', runtime: { stage: 'verifying', done: 0, total: 0 } })
  expect(page.element('#progress').getAttribute('aria-valuenow')).toBe('100')
  expect(page.element('#progress-bar').style.width).toBe('100%')
  page.publish({ phase: 'ready' })
  expect(page.element('#progress').hidden).toBe(true)
  expect(page.element('#description').textContent).toBe(loading)
})

it('shows Chinese loading and recovery copy', async () => {
  const page = startup('zh-CN')
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.document.documentElement.lang).toBe('zh-CN')
  expect(page.copy()).toMatchInlineSnapshot(`
    "正在启动 DeepSeek Harness…
    准备就绪后将自动打开工作区。"
  `)
  page.publish({ phase: 'error', profileRecovery: true, message: '插件加载失败' })
  expect(page.copy()).toMatchInlineSnapshot(`
    "DeepSeek Harness 无法启动
    DeepSeek Harness 无法打开工作区。请选择下方的恢复操作：每个操作都会结束当前尝试并重试启动。
    禁用第三方插件会保留插件文件，并在不加载它们的情况下启动 DeepSeek Harness。之后可在“桌面插件”窗口中重新启用。
    重置 Desktop 会删除桌面端的全部配置和第三方插件，不保留备份，然后重新初始化并启动。共享任务和设置会保留。
    如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。
    插件加载失败
    关闭并重启
    禁用全部第三方插件并重试
    重置 Desktop 并重试"
  `)
})

it('renders diagnostic markup as text and exposes failures from recovery actions', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  const diagnostic = '<img src=x onerror="window.compromised=true">'
  page.publish({ phase: 'error', profileRecovery: true, message: diagnostic })
  expect(page.element('#error').textContent).toBe(diagnostic)
  expect(page.element('#error').childElementCount).toBe(0)
  page.restart.mockRejectedValueOnce(new page.dom.window.Error('Retry failed'))
  page.button('#restart').click()
  await expect.poll(() => page.element('#error').textContent).toBe('Retry failed')
  expect(page.button('#restart').disabled).toBe(false)
  expect(page.button('#disable-plugins').disabled).toBe(false)
})

it('keeps subscribed state when initial status arrives late and detaches on pagehide', async () => {
  const initial = Promise.withResolvers<DesktopBackendState>()
  const page = startup('en', initial.promise)
  await page.queried
  page.publish({ phase: 'error', profileRecovery: true, message: 'Fresh startup failure' })
  initial.resolve({ phase: 'starting' })
  await initial.promise
  expect(page.element('#error').textContent).toBe('Fresh startup failure')
  expect(page.element('#actions').hidden).toBe(false)
  page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'))
  expect(page.unsubscribe).toHaveBeenCalledOnce()
  page.publish({ phase: 'starting' })
  expect(page.element('#error').textContent).toBe('Fresh startup failure')
  page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'))
  expect(page.unsubscribe).toHaveBeenCalledOnce()
})

it('shows which recovery action is running and the failure when it is rejected', async () => {
  const page = startup()
  await expect.poll(() => page.button('#restart').disabled).toBe(true)
  page.publish({ phase: 'error', profileRecovery: true, message: 'Failure details' })
  page.disablePlugins.mockRejectedValueOnce(new page.dom.window.Error('Plugin change failed'))
  page.button('#disable-plugins').click()
  expect(page.element('#recovery-status').hidden).toBe(false)
  expect(page.element('#recovery-status').textContent).toBe('Running the recovery action…')
  expect(page.button('#reset-configuration').disabled).toBe(true)
  expect(page.element('#error').hidden).toBe(true)
  await expect.poll(() => page.element('#error').textContent).toBe('Plugin change failed')
  expect(page.element('#recovery-status').hidden).toBe(true)
  expect(page.button('#reset-configuration').disabled).toBe(false)
})

it.each(['en', 'zh-CN'])('offers recovery actions with %s guidance and preserves diagnostic text', async (locale) => {
  const page = startup(locale)
  await expect.poll(() => page.button('#restart').disabled).toBe(true)
  page.publish({ phase: 'error', profileRecovery: true, message: 'Failure details' })
  expect(page.button('#disable-plugins').classList.contains('danger')).toBe(true)
  expect(page.button('#reset-configuration').classList.contains('danger')).toBe(true)
  await expect(`${page.copy()}\n`).toMatchFileSnapshot(fileURLToPath(new URL(`./expected/startup-${locale}-profile.txt`, import.meta.url)))
  for (const action of ['#disable-plugins', '#reset-configuration', '#restart']) {
    page.publish({ phase: 'error', profileRecovery: true, message: 'Failure details' })
    page.button(action).click()
    expect(page.element('#actions').hidden).toBe(false)
    expect(page.button(action).disabled).toBe(true)
  }
  expect(page.disablePlugins).toHaveBeenCalledOnce()
  expect(page.resetConfiguration).toHaveBeenCalledOnce()
  expect(page.restart).toHaveBeenCalledOnce()
  page.publish({ phase: 'error', profileRecovery: false, message: 'Failure details' })
  expect(page.button('#disable-plugins').hidden).toBe(true)
  expect(page.button('#reset-configuration').hidden).toBe(true)
  await expect(`${page.copy()}\n`).toMatchFileSnapshot(fileURLToPath(new URL(`./expected/startup-${locale}-restart.txt`, import.meta.url)))
})

it('keeps emergency diagnostics inert without shell assets', () => {
  const html = startupFailureDocument(resolveDesktopLocale('zh-CN'), '<script>alert(1)</script>', true)
  const dom = new JSDOM(html)
  expect(dom.window.document.querySelector('script')).toBeNull()
  expect(dom.window.document.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>')
  const paragraphs = [...dom.window.document.querySelectorAll('p')].map(paragraph => paragraph.textContent ?? '')
  expect(paragraphs.some(text => text.includes('重新安装'))).toBe(true)
  expect(paragraphs.some(text => text.includes('不保留备份'))).toBe(true)
  expect([...dom.window.document.querySelectorAll('form')].map(form => form.action)).toEqual([
    'dsh-recovery://restart', 'dsh-recovery://plugins', 'dsh-recovery://reset',
  ])
  dom.window.close()
})

it('offers only restart before emergency profile recovery is available', () => {
  const dom = new JSDOM(startupFailureDocument(resolveDesktopLocale('en'), 'Resources unavailable'))
  expect([...dom.window.document.querySelectorAll('form')].map(form => form.action)).toEqual(['dsh-recovery://restart'])
  dom.window.close()
})
