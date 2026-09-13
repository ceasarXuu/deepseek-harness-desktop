/**
 * The desktop Plugins panel registered into Web Settings.
 *
 * The panel is a browser plugin like any other settings tab; what makes it the
 * desktop's is where its data comes from — the shell's file dialog for choosing
 * a bundle, and the harness's own loopback routes for everything else.
 *
 * @module @deepseek-ai/dsh-desktop-ui-plugin-store/client
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginStorePanel, type PluginStorePanelInjected } from './PluginStorePanel.tsx'
import { en, zh, type PluginStoreLocaleKey } from './locales.ts'
import * as api from './api.ts'

export type { PluginStorePanelInjected, PluginStorePanelProps } from './PluginStorePanel.tsx'
export type { PluginStoreLocaleKey } from './locales.ts'
export type { PluginList, PluginView } from './api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop plugin management copy. */
    'settings.pluginStore': PluginStoreLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginStore'

/** Services required by the Settings registration. */
export const inject = ['slots', 'locale']

/** The shell bridge the preload exposes; absent outside the desktop window. */
interface ShellBridge {
  /** Ask the shell for a bundle file; `null` when the user cancelled. */
  pickPluginBundle?: () => Promise<string | null>
}

/** Contribute the installed-plugins tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-store: dictionaries')

  const t = ctx.locale.bind(NS)
  const bridge = (globalThis as { dshShell?: ShellBridge }).dshShell
  const injected = (): PluginStorePanelInjected => ({
    list: api.listPlugins,
    installFromFile: api.installFromFile,
    installFromUrl: api.installFromUrl,
    setEnabled: api.setEnabled,
    uninstall: api.uninstall,
    pickBundle: async () => (bridge?.pickPluginBundle === undefined ? null : await bridge.pickPluginBundle()),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'installed',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginStorePanel))
}
