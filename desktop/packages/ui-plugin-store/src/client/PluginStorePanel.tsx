/** The Plugins panel: what is installed, and the four actions that change it. */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginList, PluginView } from './api.ts'
import type { PluginStoreLocaleKey } from './locales.ts'
import css from './PluginStorePanel.module.css'

/** Registration-side actions the panel drives. */
export interface PluginStorePanelInjected {
  /** Read every installed plugin with its live state. */
  list: () => Promise<PluginList>
  /** Install a bundle from a path the shell's file dialog returned. */
  installFromFile: (path: string) => Promise<PluginView>
  /** Install a bundle from an http(s) URL. */
  installFromUrl: (url: string) => Promise<PluginView>
  /** Start or stop an installed plugin. */
  setEnabled: (id: string, enabled: boolean) => Promise<PluginView>
  /** Remove an installed plugin. */
  uninstall: (id: string) => Promise<void>
  /** Ask the shell for a bundle file; `null` when the user cancelled. */
  pickBundle: () => Promise<string | null>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginStorePanelProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginStore'>
  & InjectFace<PluginStorePanelInjected>

/** What the panel is showing. */
type View =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly list: PluginList }

/** One question the panel is waiting on an answer to. */
type Pending =
  | { readonly kind: 'install'; readonly source: 'file' | 'url'; readonly value: string; readonly label: string }
  | { readonly kind: 'remove'; readonly plugin: PluginView }

/** Localized state badge copy. */
const STATE_KEYS = {
  mounted: 'stateMounted',
  disabled: 'stateDisabled',
  failed: 'stateFailed',
} as const satisfies Record<PluginView['state'], PluginStoreLocaleKey>

/** Render the installed-plugin list and its actions. */
export function PluginStorePanel({ list, installFromFile, installFromUrl, setEnabled, uninstall, pickBundle, t }: PluginStorePanelProps): ReactNode {
  const [view, setView] = useState<View>({ status: 'loading' })
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setView({ status: 'ready', list: await list() })
    } catch (error: unknown) {
      setView({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [list])

  useEffect(() => { void refresh() }, [refresh])

  /** Run one action, then re-read the list. */
  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setFailure(null)
    try {
      await action()
      await refresh()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
      setPending(null)
    }
  }, [refresh])

  const choose = useCallback(async (): Promise<void> => {
    const path = await pickBundle()
    if (path !== null) setChosen(path)
  }, [pickBundle])

  const confirmPending = useCallback((): void => {
    if (pending === null) return
    if (pending.kind === 'remove') {
      const { plugin } = pending
      void run(`remove:${plugin.id}`, async () => { await uninstall(plugin.id) })
      return
    }
    void run('install', async () => {
      if (pending.source === 'file') await installFromFile(pending.value)
      else await installFromUrl(pending.value)
      setChosen(null)
      setUrl('')
    })
  }, [pending, run, uninstall, installFromFile, installFromUrl])

  return (
    <div className={css.panel}>
      <section className={css.install}>
        <h3 className={css.heading}>{t('installHeading')}</h3>
        <div className={css.row}>
          <button type="button" className={css.button} onClick={() => { void choose() }}>{t('chooseFile')}</button>
          <span className={css.file} title={chosen ?? undefined}>{chosen ?? t('noFileChosen')}</span>
          <button
            type="button"
            className={css.primary}
            disabled={chosen === null || busy !== null}
            onClick={() => {
              setPending({ kind: 'install', source: 'file', value: chosen!, label: chosen! })
            }}
          >
            {busy === 'install' ? t('installing') : t('install')}
          </button>
        </div>
        <div className={css.row}>
          <input
            className={css.input}
            type="url"
            value={url}
            placeholder={t('urlPlaceholder')}
            aria-label={t('urlPlaceholder')}
            onChange={(event) => { setUrl(event.target.value) }}
          />
          <button
            type="button"
            className={css.primary}
            disabled={url.trim() === '' || busy !== null}
            onClick={() => {
              const value = url.trim()
              setPending({ kind: 'install', source: 'url', value, label: value })
            }}
          >
            {t('install')}
          </button>
        </div>
      </section>

      {failure !== null ? <p className={css.failure} role="alert">{failure}</p> : null}

      <section aria-busy={view.status === 'loading'}>
        {view.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
        {view.status === 'failed' ? <p className={css.failure} role="alert">{view.message}</p> : null}
        {view.status === 'ready' && view.list.plugins.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
        {view.status === 'ready' && view.list.plugins.length > 0 ? (
          <>
            <ul className={css.list}>
              {view.list.plugins.map(plugin => (
                <li key={plugin.id} className={css.item}>
                  <div className={css.itemHead}>
                    <span className={css.name}>{plugin.displayName}</span>
                    <span className={css.version}>{plugin.version}</span>
                    <span className={css[plugin.state]}>{t(STATE_KEYS[plugin.state])}</span>
                  </div>
                  <p className={css.description}>{plugin.description}</p>
                  <p className={css.meta}>
                    <span>{plugin.author === '' ? t('authorUnknown') : plugin.author}</span>
                    <span>{t('sourceLabel')}: {plugin.source.kind === 'file' ? plugin.source.value : plugin.source.value}</span>
                  </p>
                  {plugin.detail !== undefined ? <p className={css.failure} role="alert">{t('detailLabel')}: {plugin.detail}</p> : null}
                  {plugin.tools.length > 0 ? (
                    <details className={css.tools}>
                      <summary>{t('toolsLabel')} ({plugin.tools.length})</summary>
                      <ul>{plugin.tools.map(tool => <li key={tool}><code>{tool}</code></li>)}</ul>
                    </details>
                  ) : null}
                  <div className={css.actions}>
                    <button
                      type="button"
                      className={css.button}
                      disabled={busy !== null}
                      onClick={() => { void run(`toggle:${plugin.id}`, async () => { await setEnabled(plugin.id, !plugin.enabled) }) }}
                    >
                      {plugin.enabled ? t('disable') : t('enable')}
                    </button>
                    <button
                      type="button"
                      className={css.danger}
                      disabled={busy !== null}
                      onClick={() => { setPending({ kind: 'remove', plugin }) }}
                    >
                      {t('remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className={css.directory}>{t('directoryLabel')}: <code>{view.list.directory}</code></p>
          </>
        ) : null}
      </section>

      {pending !== null ? (
        <div className={css.overlay} role="dialog" aria-modal="true" aria-label={pending.kind === 'install' ? t('trustTitle') : t('confirmRemove')}>
          <div className={css.dialog}>
            <h3 className={css.heading}>{pending.kind === 'install' ? t('trustTitle') : t('confirmRemove')}</h3>
            <p className={css.description}>{pending.kind === 'install' ? t('trustBody') : t('confirmRemoveBody')}</p>
            <p className={css.meta}><code>{pending.kind === 'install' ? pending.label : pending.plugin.displayName}</code></p>
            <div className={css.actions}>
              <button type="button" className={css.button} onClick={() => { setPending(null) }}>{t('cancel')}</button>
              <button type="button" className={css.primary} disabled={busy !== null} onClick={confirmPending}>
                {pending.kind === 'install' ? t('trustAccept') : t('remove')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
