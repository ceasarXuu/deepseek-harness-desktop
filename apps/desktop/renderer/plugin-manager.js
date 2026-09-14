const api = window.dshDesktop

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  const message = (key, values = {}) => messages[key].replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#package-label').textContent = messages.npmPackage
  document.querySelector('#install').textContent = messages.install
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins

  document.querySelector('#bundles-heading').textContent = messages.bundlesHeading
  document.querySelector('#bundles-description').textContent = messages.bundlesDescription
  document.querySelector('#bundle-notice').textContent = messages.bundleNotice
  document.querySelector('#bundle-file-label').textContent = messages.bundleFile
  document.querySelector('#bundle-url-label').textContent = messages.bundleUrl
  document.querySelector('#bundle-choose').textContent = messages.bundleChooseFile
  document.querySelector('#bundle-install-file').textContent = messages.bundleInstallFile
  document.querySelector('#bundle-install-url').textContent = messages.bundleInstallUrl
  document.querySelector('#bundles-installed-heading').textContent = messages.installed
  document.querySelector('#bundles-empty').textContent = messages.noBundles
  document.querySelector('#bundle-url').placeholder = messages.bundleUrlPlaceholder

  document.querySelector('#recovery-description').textContent = messages.recoveryDescription
  document.querySelector('#retry').textContent = messages.retry
  document.querySelector('#disable-all').textContent = messages.disableAll

  document.querySelector('#diagnostics-heading').textContent = messages.diagnosticsHeading
  document.querySelector('#diagnostics-description').textContent = messages.diagnosticsDescription
  document.querySelector('#diagnostics-copy').textContent = messages.diagnosticsCopy
  document.querySelector('#diagnostics-reveal').textContent = messages.diagnosticsReveal

  const list = document.querySelector('#plugins')
  const diagnosticsList = document.querySelector('#diagnostics')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const form = document.querySelector('#install-form')
  const input = document.querySelector('#package-spec')
  const refresh = document.querySelector('#refresh')
  const bundleList = document.querySelector('#bundles')
  const bundleEmpty = document.querySelector('#bundles-empty')
  const bundleFile = document.querySelector('#bundle-file')
  const bundleUrl = document.querySelector('#bundle-url')

  function setBusy(busy, statusMessage = '') {
    for (const control of document.querySelectorAll('button, input')) control.disabled = busy
    status.textContent = statusMessage
  }

  function fact(className, value) {
    const node = document.createElement('span')
    node.className = className
    node.textContent = value
    return node
  }

  async function renderPlugins() {
    const plugins = await api.plugins.list()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.enabled ? plugin.version : `${plugin.version} · ${messages.disabled}`
      identity.append(document.createTextNode(plugin.name), version)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => void run(
        () => api.plugins.remove(plugin.name),
        message('removing', { name: plugin.name }),
      ))
      const update = document.createElement('button')
      update.type = 'button'
      update.textContent = messages.update
      update.addEventListener('click', () => {
        const next = window.prompt(message('targetVersion', { name: plugin.name }), plugin.version)?.trim()
        if (next === undefined || next === '' || next === plugin.version) return
        void run(() => api.plugins.update(plugin.name, next), message('updating', { name: plugin.name }))
      })
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.textContent = plugin.enabled ? messages.disable : messages.enable
      toggle.addEventListener('click', () => void run(
        () => api.plugins.toggle(plugin.name, !plugin.enabled), messages.changingActivation,
      ))
      actions.append(toggle, update, remove)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function renderBundles() {
    const bundles = await api.bundles.list()
    bundleList.replaceChildren(...bundles.map(bundle => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      identity.className = 'bundle-identity'
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = bundle.enabled ? bundle.version : `${bundle.version} · ${messages.bundleDisabled}`
      identity.append(document.createTextNode(bundle.displayName), version)
      const facts = document.createElement('span')
      facts.className = 'bundle-facts'
      const description = fact('bundle-description', bundle.description)
      const author = fact('bundle-author', `${messages.bundleAuthor}: ${bundle.author}`)
      const source = fact('bundle-source', `${messages.bundleSource}: ${bundle.source.value}`)
      facts.append(description, author, source)
      if (bundle.tools.length !== 0) facts.append(fact('bundle-tools', `${messages.bundleTools}: ${bundle.tools.join(', ')}`))
      if (bundle.detail !== undefined) facts.append(fact('package-detail', bundle.detail))
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.textContent = bundle.enabled ? messages.disable : messages.enable
      toggle.addEventListener('click', () => void run(
        () => api.bundles.setEnabled(bundle.id, !bundle.enabled), messages.changingBundleActivation,
      ))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => void run(
        () => api.bundles.remove(bundle.id),
        message('removing', { name: bundle.displayName }),
      ))
      actions.append(toggle, remove)
      item.append(identity, facts, actions)
      return item
    }))
    bundleEmpty.hidden = bundles.length !== 0
  }

  function diagnosticRow(label, value) {
    const item = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'diagnostic-label'
    name.textContent = label
    const factNode = document.createElement('span')
    factNode.className = 'diagnostic-value'
    factNode.textContent = value
    item.append(name, factNode)
    return item
  }

  let diagnosticsBlock = ''

  async function renderDiagnostics() {
    const diagnostics = await api.diagnostics.get()
    diagnosticsBlock = diagnostics.block
    const startup = diagnostics.startupFailed
      ? message('diagnosticsStartupFailed', { message: diagnostics.startupFailure ?? '' })
      : messages.diagnosticsStartupSucceeded
    diagnosticsList.replaceChildren(
      diagnosticRow(messages.diagnosticsApplication, diagnostics.applicationVersion),
      diagnosticRow(messages.diagnosticsDsh, diagnostics.dshVersion),
      diagnosticRow(messages.diagnosticsHome, diagnostics.harnessHome),
      diagnosticRow(messages.diagnosticsRuntime, diagnostics.runtimeLocation),
      diagnosticRow(messages.diagnosticsStartup, startup),
    )
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagnosticsBlock)
      status.textContent = messages.diagnosticsCopied
    } catch {
      status.textContent = messages.diagnosticsCopyFailed
    }
  }

  async function revealDiagnostics() {
    setBusy(true, messages.diagnosticsRevealing)
    try {
      await api.diagnostics.reveal()
      status.textContent = messages.diagnosticsRevealed
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function render() {
    const backend = await api.backend.status()
    document.querySelector('#recovery').hidden = backend.phase !== 'error'
    document.querySelector('#startup-error').textContent = backend.phase === 'error' ? backend.message : ''
    await renderPlugins()
    await renderBundles()
    await renderDiagnostics()
  }

  async function run(operation, statusMessage) {
    setBusy(true, statusMessage)
    try {
      await operation()
      await render()
      status.textContent = messages.operationComplete
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function load(statusMessage, success) {
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = input.value.trim()
    if (spec === '') return
    void run(async () => {
      await api.plugins.add(spec)
      input.value = ''
    }, message('installing', { spec }))
  })
  document.querySelector('#bundle-choose').addEventListener('click', () => void pickBundleFile())
  document.querySelector('#bundle-file-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const path = bundleFile.value.trim()
    if (path === '') {
      status.textContent = messages.noBundleSelected
      return
    }
    void run(async () => {
      await api.bundles.installFromPath(path)
      bundleFile.value = ''
    }, message('installingBundle', { source: path }))
  })
  document.querySelector('#bundle-url-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const url = bundleUrl.value.trim()
    if (url === '') return
    void run(async () => {
      await api.bundles.installFromUrl(url)
      bundleUrl.value = ''
    }, message('installingBundle', { source: url }))
  })
  document.querySelector('#retry').addEventListener('click', () => void run(() => api.backend.retry(), messages.retry))
  document.querySelector('#disable-all').addEventListener('click', () => void run(() => api.plugins.disableAll(), messages.changingActivation))
  document.querySelector('#diagnostics-copy').addEventListener('click', () => { void copyDiagnostics() })
  document.querySelector('#diagnostics-reveal').addEventListener('click', () => { void revealDiagnostics() })
  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))

  async function pickBundleFile() {
    try {
      const path = await api.bundles.pickFile()
      if (path === undefined) return
      bundleFile.value = path
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  await load(messages.loadingPlugins, '')
}

void main()
