#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const tlsDefaultEnabled = process.env.VIBETERM_TLS === '1'
const PROJECT_NAME_MAX_LENGTH = 80
const options = {
  host: process.env.VIBETERM_UI_HOST || '0.0.0.0',
  port: Number(process.env.VIBETERM_UI_PORT || 3457),
  file: process.env.VIBETERM_UI_FILE || 'server/vibeterm-ui.json',
  tls: tlsDefaultEnabled,
  tlsCert: process.env.VIBETERM_TLS_CERT || '.certs/vibeterm.cert.pem',
  tlsKey: process.env.VIBETERM_TLS_KEY || '.certs/vibeterm.key.pem',
  tlsDays: Number(process.env.VIBETERM_TLS_DAYS || 3650),
  sttCommand: process.env.VIBETERM_STT_COMMAND || '',
  sttMaxBytes: Number(process.env.VIBETERM_STT_MAX_BYTES || 10 * 1024 * 1024),
  sttOpenaiModel: process.env.VIBETERM_STT_OPENAI_MODEL || 'whisper-1',
  sttOpenaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  sttTimeoutMs: Number(process.env.VIBETERM_STT_TIMEOUT_MS || 30000),
  projectToken: process.env.VIBETERM_PROJECT_TOKEN || '',
  projectsDir: process.env.VIBETERM_PROJECTS_DIR || '.projects',
  tmuxExecRow: firstEnv('VIBETERM_TMUX_EXEC_ROW'),
  tmuxSessionPrefix: process.env.VIBETERM_TMUX_SESSION_PREFIX || 'vibeterm-',
  tmuxLegacySessionPrefixes: process.env.VIBETERM_TMUX_LEGACY_SESSION_PREFIXES,
  tmuxHistoryLines: Number(process.env.VIBETERM_TMUX_HISTORY_LINES || 240),
  tmuxBootDelayMs: Number(process.env.VIBETERM_TMUX_BOOT_DELAY_MS || 1200),
  tmuxRestartExec: firstEnv('VIBETERM_TMUX_RESTART_EXEC') !== '0',
  tmuxRestartDelay: Number(process.env.VIBETERM_TMUX_RESTART_DELAY || 2),
  tmuxAutoExport: process.env.VIBETERM_TMUX_AUTO_EXPORT !== '0',
  tmuxExportBasePort: Number(process.env.VIBETERM_TMUX_EXPORT_BASE_PORT || 7681),
  tmuxExportDuration: process.env.VIBETERM_TMUX_EXPORT_DURATION || '24h',
  tmuxExportTls: process.env.VIBETERM_TMUX_EXPORT_TLS
    ? process.env.VIBETERM_TMUX_EXPORT_TLS !== '0'
    : tlsDefaultEnabled,
  publicHost: process.env.VIBETERM_PUBLIC_HOST || '',
  publicUrl: process.env.VIBETERM_PUBLIC_URL || '',
  sessionNamespace: process.env.VIBETERM_SESSION_NAMESPACE || 'even-glasses',
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--host') {
    options.host = args[index + 1] || options.host
    index += 1
  } else if (arg === '--port') {
    options.port = Number(args[index + 1] || options.port)
    index += 1
  } else if (arg === '--file') {
    options.file = args[index + 1] || options.file
    index += 1
  } else {
    console.error(`vibeterm-config-server: unknown option ${arg}`)
    process.exit(1)
  }
}

if (!Number.isInteger(options.port) || options.port <= 0) {
  console.error(`vibeterm-config-server: invalid port ${options.port}`)
  process.exit(1)
}

if (!Number.isFinite(options.sttMaxBytes) || options.sttMaxBytes <= 0) {
  console.error(`vibeterm-config-server: invalid VIBETERM_STT_MAX_BYTES ${options.sttMaxBytes}`)
  process.exit(1)
}

if (!Number.isFinite(options.sttTimeoutMs) || options.sttTimeoutMs <= 0) {
  console.error(`vibeterm-config-server: invalid VIBETERM_STT_TIMEOUT_MS ${options.sttTimeoutMs}`)
  process.exit(1)
}

if (!Number.isFinite(options.tlsDays) || options.tlsDays <= 0) {
  console.error(`vibeterm-config-server: invalid VIBETERM_TLS_DAYS ${options.tlsDays}`)
  process.exit(1)
}

if (options.publicUrl) {
  try {
    new URL(options.publicUrl)
  } catch {
    console.error(`vibeterm-config-server: invalid VIBETERM_PUBLIC_URL ${options.publicUrl}`)
    process.exit(1)
  }
}

if (!options.tmuxExecRow.trim()) {
  console.error('vibeterm-config-server: set VIBETERM_TMUX_EXEC_ROW in .env.local, for example:')
  console.error("  VIBETERM_TMUX_EXEC_ROW='git init >/dev/null 2>&1 || true; codex --yolo --enable use_legacy_landlock'")
  process.exit(1)
}

const uiFile = resolve(options.file)
const projectsDir = resolve(options.projectsDir)
const tlsMaterial = options.tls || options.tmuxExportTls ? ensureTlsMaterial() : undefined
let tmuxEventId = 0

const requestHandler = async (request, response) => {
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url || '/', `${publicProtocol()}://${request.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      tls: options.tls,
      tmuxExportTls: options.tmuxExportTls,
      stt: sttMode(),
      tmux: await commandExists('tmux'),
      projectsDir,
    })
    return
  }

  if (request.method === 'GET' && (url.pathname === '/setup' || url.pathname === '/setup.json')) {
    if (!authorized(request, url)) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }

    const payload = setupPayload(request.headers.host || '')
    if (url.pathname === '/setup.json') {
      sendJson(response, 200, payload)
    } else {
      sendHtml(response, 200, setupHtml(payload))
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/transcribe') {
    await handleTranscribe(request, response)
    return
  }

  if (url.pathname.startsWith('/api/projects')) {
    await handleProjects(request, response, url)
    return
  }

  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/ui-config') {
    await handleTmuxApi(request, response, url)
    return
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }

  if (url.pathname !== '/ui.json' && url.pathname !== '/api/ui-config') {
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  try {
    const raw = await readFile(uiFile, 'utf8')
    const parsed = JSON.parse(raw)
    sendJson(response, 200, parsed)
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const server = options.tls
  ? createHttpsServer(tlsMaterial.credentials, requestHandler)
  : createHttpServer(requestHandler)

server.listen(options.port, options.host, () => {
  void printStartupInfo()
})

async function printStartupInfo() {
  const setup = setupPayload('')
  console.log(`VibeTerm transport: ${publicProtocol()}`)
  if (tlsMaterial) {
    console.log(`VibeTerm TLS cert: ${tlsMaterial.certPath}${tlsMaterial.generated ? ' (generated local self-signed)' : ''}`)
  }
  if (options.tls && tlsMaterial?.generated) {
    console.log('Self-signed HTTPS requires the phone/Hub WebView to trust the cert. Set VIBETERM_TLS=0 for plain HTTP.')
  }
  if (!options.tls) {
    console.log('TLS is off. Use this over a private LAN/VPN such as Tailscale.')
  }
  console.log(`VibeTerm UI config: ${setup.settings.uiConfigUrl}`)
  console.log(`VibeTerm STT: ${setup.settings.sttUrl} (${sttMode()})`)
  console.log(`VibeTerm tmux projects: ${projectsDir}`)
  console.log(`VibeTerm tmux prefix: ${options.tmuxSessionPrefix}`)
  console.log(`VibeTerm tmux exec restart: ${options.tmuxRestartExec ? `on after ${options.tmuxRestartDelay}s` : 'off'}`)
  console.log(
    `VibeTerm tmux web export: ${options.tmuxAutoExport ? `on from ${options.tmuxExportBasePort} (${exportProtocol()})` : 'off'}`,
  )
  if (options.tmuxAutoExport && !options.tmuxExportTls) {
    console.log('WARNING: tmux web export is plain HTTP. Use only on a trusted LAN/VPN, for example to attach from a laptop browser.')
  }
  console.log(`VibeTerm setup URL: ${setup.setupJsonUrl}`)
  console.log('Paste that URL into VibeTerm Settings -> Load Settings From URL.')
  console.log(`File: ${uiFile}`)
}

function ensureTlsMaterial() {
  const certPath = resolve(options.tlsCert)
  const keyPath = resolve(options.tlsKey)
  const generated = !existsSync(certPath) || !existsSync(keyPath)

  if (generated) {
    generateLocalCertificate(certPath, keyPath)
  }

  return {
    certPath,
    keyPath,
    generated,
    credentials: {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    },
  }
}

function generateLocalCertificate(certPath, keyPath) {
  mkdirSync(dirname(certPath), { recursive: true })
  mkdirSync(dirname(keyPath), { recursive: true })

  const configPath = join(dirname(certPath), 'vibeterm.openssl.cnf')
  writeFileSync(configPath, opensslConfig(), { mode: 0o600 })

  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-days',
      String(Math.floor(options.tlsDays)),
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-config',
      configPath,
    ],
    { encoding: 'utf8' },
  )

  if (result.error) {
    throw new Error(`Unable to generate VibeTerm TLS cert with openssl: ${result.error.message}. Set VIBETERM_TLS=0 for HTTP.`)
  }
  if (result.status !== 0) {
    throw new Error(`Unable to generate VibeTerm TLS cert with openssl: ${result.stderr || result.stdout}`)
  }
}

function opensslConfig() {
  const dnsNames = certificateDnsNames()
  const ipNames = certificateIpNames()
  const altNames = [
    ...dnsNames.map((name, index) => `DNS.${index + 1} = ${opensslConfigValue(name)}`),
    ...ipNames.map((ip, index) => `IP.${index + 1} = ${opensslConfigValue(ip)}`),
  ]

  return `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = ${opensslConfigValue(options.publicHost || hostname() || 'localhost')}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
${altNames.join('\n')}
`
}

function certificateDnsNames() {
  const names = new Set(['localhost'])
  for (const value of [options.publicHost, options.host, hostname()]) {
    const name = String(value || '').trim()
    if (!name || name === '0.0.0.0' || name === '::' || isIP(name)) continue
    names.add(name)
  }
  return [...names]
}

function certificateIpNames() {
  const ips = new Set(['127.0.0.1'])
  for (const value of [options.publicHost, options.host]) {
    const ip = String(value || '').trim()
    if (isIP(ip)) ips.add(ip)
  }
  for (const values of Object.values(networkInterfaces())) {
    for (const address of values || []) {
      if (address.family === 'IPv4' && !address.internal) {
        ips.add(address.address)
      }
    }
  }
  return [...ips]
}

function opensslConfigValue(value) {
  return String(value || '')
    .replaceAll(/[\r\n]/g, '')
    .trim()
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-VibeTerm-Input-Label')
  response.setHeader('Cache-Control', 'no-store')
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(value)}\n`)
}

function sendHtml(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(value)
}

function setupPayload(requestHost) {
  const baseUrl = publicBaseUrl(requestHost)
  const settings = {
    serverUrl: baseUrl,
    uiConfigUrl: `${baseUrl}/ui.json`,
    sttUrl: `${baseUrl}/api/transcribe`,
    token: options.projectToken,
    provider: 'tmux',
    cwd: '',
    autoAttach: true,
    startPrompt: '',
    sessionNamespace: options.sessionNamespace,
    showExternalSessions: false,
  }

  return {
    name: 'VibeTerm',
    setupUrl: setupServerUrl('/setup', baseUrl),
    setupJsonUrl: setupServerUrl('/setup.json', baseUrl),
    settings,
  }
}

function publicBaseUrl(requestHost) {
  if (options.publicUrl) {
    return String(options.publicUrl).replace(/\/+$/g, '')
  }

  return `${publicProtocol()}://${publicHost(requestHost)}:${options.port}`
}

function publicHost(requestHost) {
  const requestName = String(requestHost || '').split(':')[0]
  return (
    options.publicHost ||
    requestName ||
    (options.host === '0.0.0.0' || options.host === '::' ? hostname() : options.host) ||
    'localhost'
  )
}

function publicProtocol() {
  return options.tls ? 'https' : 'http'
}

function exportProtocol() {
  return options.tmuxExportTls ? 'https' : 'http'
}

function setupServerUrl(pathname, baseUrl) {
  const url = new URL(pathname, baseUrl)
  if (options.projectToken) {
    url.searchParams.set('token', options.projectToken)
  }
  return url.toString()
}

function setupHtml(payload) {
  const settingsJson = JSON.stringify(payload.settings, null, 2)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>VibeTerm Setup</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 48rem; line-height: 1.45; }
      code, pre { background: #f4f4f4; border-radius: 6px; }
      code { padding: 0.12rem 0.3rem; }
      pre { overflow: auto; padding: 1rem; }
      a { color: #0645ad; }
    </style>
  </head>
  <body>
    <h1>VibeTerm Setup</h1>
    <p>Copy this setup URL and paste it into VibeTerm Settings -> Load Settings From URL:</p>
    <p><a href="${escapeHtml(payload.setupJsonUrl)}">${escapeHtml(payload.setupJsonUrl)}</a></p>
    <p>If this server uses a local self-signed certificate, the phone/Hub WebView must trust it before loading settings.</p>
    <p>Keep the token private. The raw runtime settings are shown below for troubleshooting.</p>
    <pre>${escapeHtml(settingsJson)}</pre>
  </body>
</html>
`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function handleProjects(request, response, url) {
  if (!authorized(request, url)) {
    sendJson(response, 401, { error: 'Unauthorized' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    sendJson(response, 200, { projects: await listProjects() })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/projects') {
    try {
      const body = await readJsonBody(request)
      const result = await initializeProject({
        name: body.name,
        launch: Boolean(body.launch),
        autoExport: body.autoExport !== false,
        requestHost: request.headers.host || '',
      })
      sendJson(response, 200, result)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      sendJson(response, status, { error: formatError(error) })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/projects/reinitialize') {
    try {
      const body = await readJsonBody(request)
      const result = await reinitializeProject({
        name: body.name,
        sessionId: body.sessionId,
        autoExport: body.autoExport !== false,
        requestHost: request.headers.host || '',
      })
      sendJson(response, 200, result)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      sendJson(response, status, { error: formatError(error) })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/projects/close') {
    try {
      const body = await readJsonBody(request)
      const result = await closeProjectTerminal({
        name: body.name,
        sessionId: body.sessionId,
      })
      sendJson(response, 200, result)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      sendJson(response, status, { error: formatError(error) })
    }
    return
  }

  sendJson(response, 404, { error: 'Not found' })
}

async function handleTmuxApi(request, response, url) {
  const provider = providerFromRequest(request, url)
  if (provider && provider !== 'tmux') {
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  if (!authorized(request, url)) {
    sendJson(response, 401, { error: 'Unauthorized' })
    return
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/info') {
      const tmuxVersion = await runCommand('tmux', ['-V']).then((result) => result.stdout.trim()).catch(() => '')
      sendJson(response, 200, {
        provider: 'tmux',
        version: tmuxVersion,
        projectsDir,
        autoExport: options.tmuxAutoExport,
        exportBasePort: options.tmuxExportBasePort,
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const limit = Number(url.searchParams.get('limit') || 20)
      const sessions = await listTmuxSessions(Number.isFinite(limit) ? limit : 20)
      sendJson(response, 200, { sessions })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/exports') {
      sendJson(response, 200, await listTmuxWebExports(request.headers.host || ''))
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/messages') {
      const { sessionId } = await resolveTmuxProjectTarget({
        sessionId: url.searchParams.get('sessionId'),
      })
      const text = await captureTmuxPane(sessionId)
      sendJson(response, 200, {
        state: 'running',
        messages: [
          {
            id: ++tmuxEventId,
            type: 'terminal_snapshot',
            sessionId,
            provider: 'tmux',
            text,
          },
        ],
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      await streamTmuxEvents(request, response, url)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/prompt') {
      const body = await readJsonBody(request)
      const text = String(body.text || '').trim()
      const { sessionId } = await resolveTmuxProjectTarget({
        sessionId: body.sessionId,
        projectName: body.projectName,
        cwd: body.cwd,
        startIfMissing: true,
      })
      if (text) {
        await sendTextToTmux(sessionId, text)
      }
      sendJson(response, 200, { ok: true, sessionId, provider: 'tmux' })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/key') {
      const body = await readJsonBody(request)
      const { sessionId } = await resolveTmuxProjectTarget({ sessionId: body.sessionId })
      const key = normalizeTmuxKey(body.key)
      await sendKeyToTmux(sessionId, key)
      sendJson(response, 200, { ok: true, sessionId, key })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/interrupt') {
      const body = await readJsonBody(request)
      const { sessionId } = await resolveTmuxProjectTarget({ sessionId: body.sessionId })
      await runCommand('tmux', ['send-keys', '-t', sessionId, 'C-c'])
      sendJson(response, 200, { ok: true })
      return
    }

    if (
      request.method === 'POST' &&
      ['/api/permission-response', '/api/question-response'].includes(url.pathname)
    ) {
      sendJson(response, 200, { ok: true })
      return
    }

    sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    sendJson(response, status, { error: formatError(error) })
  }
}

async function initializeProject({ name, launch, autoExport, requestHost }) {
  const projectName = normalizeProjectName(name)
  const projectDir = projectPath(projectName)
  const steps = []

  steps.push(`mkdir -p ${relativeProjectPath(projectDir)}`)
  await mkdir(projectDir, { recursive: true })

  let exportInfo
  if (launch) {
    const sessionName = tmuxSessionName(projectName)
    await ensureTmuxExecSession(sessionName, projectDir, steps)
    if (options.tmuxAutoExport && autoExport) {
      exportInfo = await ensureTmuxWebExport(sessionName, requestHost, steps)
    } else {
      steps.push('web export skipped')
    }
  }

  return {
    ok: true,
    name: projectName,
    cwd: projectDir,
    relativePath: relativeProjectPath(projectDir),
    sessionId: launch ? tmuxSessionName(projectName) : undefined,
    provider: launch ? 'tmux' : undefined,
    webUrl: exportInfo?.url,
    webPort: exportInfo?.port,
    steps,
  }
}

async function reinitializeProject({ name, sessionId, autoExport, requestHost }) {
  const projectName = name ? normalizeProjectName(name) : projectNameFromSessionId(sessionId)
  const projectDir = projectPath(projectName)
  if (!(await directoryExists(projectDir))) {
    const error = new Error(`No project folder named ${projectName}`)
    error.status = 404
    throw error
  }

  const sessionName = tmuxSessionName(projectName)
  const steps = []
  let exportInfo

  steps.push(`reuse ${relativeProjectPath(projectDir)}`)
  await killTmuxWebExport(sessionName, steps)
  await killTmuxSession(sessionName, steps)
  await ensureTmuxExecSession(sessionName, projectDir, steps)
  if (options.tmuxAutoExport && autoExport) {
    exportInfo = await ensureTmuxWebExport(sessionName, requestHost, steps)
  } else {
    steps.push('web export skipped')
  }

  return {
    ok: true,
    name: projectName,
    cwd: projectDir,
    relativePath: relativeProjectPath(projectDir),
    sessionId: sessionName,
    provider: 'tmux',
    webUrl: exportInfo?.url,
    webPort: exportInfo?.port,
    steps,
  }
}

async function closeProjectTerminal({ name, sessionId }) {
  const projectName = name ? normalizeProjectName(name) : projectNameFromSessionId(sessionId)
  const projectDir = projectPath(projectName)
  if (!(await directoryExists(projectDir))) {
    const error = new Error(`No project folder named ${projectName}`)
    error.status = 404
    throw error
  }

  const sessionName = tmuxSessionName(projectName)
  const requestedSessionName = sessionId ? requiredSessionId(sessionId) : ''
  const sessionNames = [sessionName]
  if (requestedSessionName && requestedSessionName !== sessionName) {
    sessionNames.push(requestedSessionName)
  }

  const steps = [`keep project folder ${relativeProjectPath(projectDir)}`]
  for (const name of sessionNames) {
    await killTmuxWebExport(name, steps)
    await killTmuxSession(name, steps)
  }

  const deleteCommand = `rm -rf ${shellQuote(projectDir)}`
  steps.push(`manual delete only: ${deleteCommand}`)

  return {
    ok: true,
    name: projectName,
    cwd: projectDir,
    relativePath: relativeProjectPath(projectDir),
    sessionId: sessionName,
    provider: 'tmux',
    deleteCommand,
    steps,
  }
}

async function ensureTmuxExecSession(sessionName, cwd, steps = []) {
  if (await tmuxHasSession(sessionName)) {
    steps.push(`tmux session ${sessionName} already running`)
    return
  }

  steps.push(`tmux new-session -d -s ${sessionName}`)
  steps.push(`run VIBETERM_TMUX_EXEC_ROW in ${relativeProjectPath(cwd)}`)
  const command = tmuxExecLauncher(cwd)
  await runCommand('tmux', ['new-session', '-d', '-s', sessionName, command])
}

async function killTmuxSession(sessionName, steps = []) {
  if (!(await tmuxHasSession(sessionName))) {
    steps.push(`tmux session ${sessionName} was not running`)
    return
  }

  steps.push(`tmux kill-session -t ${sessionName}`)
  await runCommand('tmux', ['kill-session', '-t', sessionName])
  await delay(250)
}

async function killTmuxWebExport(sessionName, steps = []) {
  const processes = await getTmuxExportProcesses(sessionName)
  if (processes.length === 0) {
    steps.push('web export was not running')
    return
  }

  for (const processInfo of processes) {
    steps.push(`stop web export pid ${processInfo.pid}`)
    killProcessGroup(processInfo.pid, 'SIGTERM')
  }
  await delay(500)
  for (const processInfo of processes) {
    killProcessGroup(processInfo.pid, 'SIGKILL')
  }
}

async function ensureTmuxWebExport(sessionName, requestHost, steps = []) {
  const existing = await getExistingExport(sessionName)
  if (existing) {
    const url = exportUrl(existing.port, requestHost)
    steps.push(`web export already running: ${url}`)
    return { ...existing, url }
  }

  if (!(await commandExists('ttyd'))) {
    steps.push('web export skipped: missing ttyd')
    return undefined
  }
  if (!(await commandExists('timeout'))) {
    steps.push('web export skipped: missing timeout')
    return undefined
  }

  const port = await findFreePort(options.tmuxExportBasePort)
  steps.push(`web export ${exportUrl(port, requestHost)}`)

  const ttydArgs = [
    '--foreground',
    '-k',
    '10s',
    options.tmuxExportDuration,
    'ttyd',
    '-W',
    '-m',
    '1',
    '-p',
    String(port),
  ]

  if (options.tmuxExportTls) {
    ttydArgs.push('-S', '-C', tlsMaterial.certPath, '-K', tlsMaterial.keyPath)
  }

  ttydArgs.push(
    '-t',
    `titleFixed=tmux:${sessionName}`,
    '-t',
    'scrollback=20000',
    '-t',
    'scrollOnUserInput=false',
    'tmux',
    'attach',
    '-t',
    sessionName,
  )

  const child = spawn(
    'timeout',
    ttydArgs,
    {
      detached: true,
      stdio: 'ignore',
    },
  )
  child.unref()
  await delay(250)

  return { pid: child.pid, port, url: exportUrl(port, requestHost) }
}

async function listProjects() {
  await mkdir(projectsDir, { recursive: true })
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => [])
  const sessions = new Map((await listTmuxSessions(1000)).map((session) => [session.id, session]))

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      cwd: projectPath(entry.name),
      sessionId: tmuxSessionName(entry.name),
      session: sessions.get(tmuxSessionName(entry.name)) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function listTmuxSessions(limit = 20) {
  const result = await runCommand('tmux', [
    'list-sessions',
    '-F',
    '#S|#{session_created}|#{session_attached}|#{session_windows}',
  ]).catch((error) => {
    if (/no server running|failed to connect/i.test(formatError(error))) return { stdout: '' }
    throw error
  })

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.split('|')[0]?.startsWith(options.tmuxSessionPrefix))
    .slice(0, Math.max(0, limit))
    .map((line) => {
      const [name, created, attached, windows] = line.split('|')
      const projectName = projectNameFromTmuxSession(name)
      return {
        id: name,
        title: projectName,
        provider: 'tmux',
        status: attached === '1' ? 'attached' : 'running',
        timestamp: created ? new Date(Number(created) * 1000).toISOString() : undefined,
        cwd: projectPathIfExists(projectName),
        windows: Number(windows || 0),
      }
    })
}

async function listTmuxWebExports(requestHost) {
  if (!options.tmuxAutoExport) {
    return {
      enabled: false,
      exportBasePort: options.tmuxExportBasePort,
      exports: [],
    }
  }

  const sessions = new Map((await listTmuxSessions(1000)).map((session) => [session.id, session]))
  const exports = []

  for (const exportInfo of await getTmuxExportProcesses()) {
    const session = sessions.get(exportInfo.sessionName)
    const projectName = projectNameFromTmuxSession(exportInfo.sessionName)
    exports.push({
      sessionId: exportInfo.sessionName,
      projectName,
      title: session?.title || projectName,
      provider: 'tmux',
      status: session?.status || 'exported',
      cwd: session?.cwd || projectPathIfExists(projectName),
      pid: exportInfo.pid,
      port: exportInfo.port,
      url: exportUrl(exportInfo.port, requestHost),
    })
  }

  return {
    enabled: true,
    exportBasePort: options.tmuxExportBasePort,
    duration: options.tmuxExportDuration,
    exports,
  }
}

async function streamTmuxEvents(request, response, url) {
  const { sessionId } = await resolveTmuxProjectTarget({
    sessionId: url.searchParams.get('sessionId'),
  })
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })

  let closed = false
  let lastText = ''
  const sendSnapshot = async () => {
    if (closed) return
    try {
      const text = await captureTmuxPane(sessionId)
      if (text !== lastText) {
        lastText = text
        const id = ++tmuxEventId
        response.write(`id: ${id}\n`)
        response.write(
          `data: ${JSON.stringify({
            id,
            type: 'terminal_snapshot',
            sessionId,
            provider: 'tmux',
            text,
          })}\n\n`,
        )
      }
    } catch (error) {
      const id = ++tmuxEventId
      response.write(`id: ${id}\n`)
      response.write(`data: ${JSON.stringify({ id, type: 'error', message: formatError(error) })}\n\n`)
    }
  }

  await sendSnapshot()
  const timer = setInterval(sendSnapshot, 1200)
  request.on('close', () => {
    closed = true
    clearInterval(timer)
  })
}

async function captureTmuxPane(sessionId) {
  const result = await runCommand('tmux', [
    'capture-pane',
    '-t',
    sessionId,
    '-p',
    '-S',
    `-${Math.max(20, options.tmuxHistoryLines)}`,
  ])
  return result.stdout.replace(/\s+$/g, '')
}

async function sendTextToTmux(sessionId, text) {
  await runCommand('tmux', ['send-keys', '-t', sessionId, '-l', oneLine(text)])
  await runCommand('tmux', ['send-keys', '-t', sessionId, 'Enter'])
}

async function sendKeyToTmux(sessionId, key) {
  if (!(await tmuxHasSession(sessionId))) {
    const error = new Error(`No tmux project named ${sessionId}`)
    error.status = 404
    throw error
  }
  await runCommand('tmux', ['send-keys', '-t', sessionId, key])
}

async function tmuxHasSession(sessionName) {
  return commandOk('tmux', ['has-session', '-t', sessionName])
}

async function getExistingExport(sessionName) {
  for (const processInfo of await getTmuxExportProcesses(sessionName)) {
    if (Number.isFinite(processInfo.port)) {
      return processInfo
    }
  }
  return undefined
}

async function getTmuxExportProcesses(sessionName) {
  const result = await runCommand('ps', ['-eo', 'pid=,args='])
  const processesByKey = new Map()

  for (const line of result.stdout.split('\n')) {
    const exportSessionName = tmuxExportSessionNameFromCommand(line)
    if (!exportSessionName) continue
    if (sessionName && exportSessionName !== sessionName) continue
    if (!tmuxSessionBelongsToServer(exportSessionName)) continue
    if (!line.includes('ttyd ') && !line.includes(' timeout ')) continue
    if (!line.includes('titleFixed') && !line.includes('tmux attach')) continue

    const pid = Number(line.trim().split(/\s+/, 1)[0])
    if (!Number.isFinite(pid)) continue

    const processInfo = {
      pid,
      port: Number((line.match(/ -p ([0-9]+)/) || [])[1]),
      sessionName: exportSessionName,
      command: line.trim(),
    }
    const key = `${processInfo.sessionName}:${Number.isFinite(processInfo.port) ? processInfo.port : pid}`
    const existing = processesByKey.get(key)
    if (!existing || tmuxExportProcessRank(processInfo) > tmuxExportProcessRank(existing)) {
      processesByKey.set(key, processInfo)
    }
  }

  return [...processesByKey.values()]
    .filter((processInfo) => Number.isFinite(processInfo.port))
    .sort((a, b) => a.port - b.port || a.sessionName.localeCompare(b.sessionName))
}

function tmuxExportSessionNameFromCommand(command) {
  const patterns = [
    /titleFixed=tmux:([^\s]+)/,
    /titleFixed\s+tmux:([^\s]+)/,
    /tmux\s+attach(?:-session)?\s+-t\s+=?([^\s]+)/,
  ]

  for (const pattern of patterns) {
    const match = command.match(pattern)
    if (match?.[1]) return match[1]
  }
  return ''
}

function tmuxSessionBelongsToServer(sessionName) {
  return sessionPrefixesForProjectDecode().some((prefix) => String(sessionName || '').startsWith(prefix))
}

function tmuxExportProcessRank(processInfo) {
  if (processInfo.command.includes('timeout --foreground')) return 30
  if (processInfo.command.includes('ttyd ')) return 20
  return 10
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return
  } catch {}

  try {
    process.kill(pid, signal)
  } catch {}
}

async function findFreePort(basePort) {
  let port = basePort
  while (await portInUse(port)) {
    port += 1
  }
  return port
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || 'bash', ['-lc', `(echo >/dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1`])
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

function exportUrl(port, requestHost) {
  return `${exportProtocol()}://${publicHost(requestHost)}:${port}`
}

function projectPath(name) {
  const fullPath = resolve(projectsDir, name)
  const rel = relative(projectsDir, fullPath)
  if (rel.startsWith('..') || rel === '' || rel.split(/[\\/]/).includes('..')) {
    const error = new Error('Project path escapes projects directory')
    error.status = 400
    throw error
  }
  return fullPath
}

function projectPathIfExists(name) {
  try {
    const fullPath = projectPath(name)
    return existsSync(fullPath) ? fullPath : undefined
  } catch {
    return undefined
  }
}

async function resolveTmuxProjectTarget({ sessionId, projectName, cwd, startIfMissing = false }) {
  const requestedSessionId = sessionId ? requiredSessionId(sessionId) : ''
  const name = sessionId ? projectNameFromSessionId(sessionId) : normalizeProjectName(projectName)
  const resolvedSessionId = tmuxSessionName(name)
  const projectDir = projectPathIfExists(name)

  if (await tmuxHasSession(resolvedSessionId)) {
    return { projectName: name, sessionId: resolvedSessionId, cwd: projectDir }
  }

  if (
    requestedSessionId &&
    requestedSessionId !== resolvedSessionId &&
    (await tmuxHasSession(requestedSessionId))
  ) {
    await runCommand('tmux', ['rename-session', '-t', requestedSessionId, resolvedSessionId])
    return { projectName: name, sessionId: resolvedSessionId, cwd: projectDir }
  }

  if (!startIfMissing) {
    throw noTmuxProjectError(name)
  }

  const launchDir = projectDir || (cwd ? String(cwd) : '')
  if (!launchDir || !(await directoryExists(launchDir))) {
    throw noTmuxProjectError(name)
  }

  await ensureTmuxExecSession(resolvedSessionId, launchDir, [])
  await delay(options.tmuxBootDelayMs)
  return { projectName: name, sessionId: resolvedSessionId, cwd: launchDir }
}

function noTmuxProjectError(projectName) {
  const error = new Error(`No tmux project named ${projectName}`)
  error.status = 404
  return error
}

function relativeProjectPath(projectDir) {
  const rel = relative(process.cwd(), projectDir)
  return rel.startsWith('..') ? projectDir : rel || '.'
}

async function directoryExists(path) {
  return stat(path).then((stats) => stats.isDirectory()).catch(() => false)
}

function normalizeProjectName(value) {
  const name = folderSafeProjectName(value)
  if (!name || name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    const error = new Error('Use a project name that can become a folder name, for example letters, numbers, spaces, dot, dash, or underscore.')
    error.status = 400
    throw error
  }
  return name
}

function folderSafeProjectName(value) {
  const withoutAccents = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')

  const withSpokenPunctuation = withoutAccents
    .replace(/\bunder\s+score\b/gi, '_')
    .replace(/\bunderscore\b/gi, '_')
    .replace(/\b(?:dash|hyphen|minus)\b/gi, '-')
    .replace(/\b(?:dot|period|point)\b/gi, '.')
    .replace(/\b(?:space|blank)\b/gi, '_')
    .replace(/\b(?:double\s+quote|single\s+quote|quote|apostrophe|slash|backslash|colon|semicolon|comma)\b/gi, ' ')

  return withSpokenPunctuation
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_?([.-])_?/g, '$1')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, PROJECT_NAME_MAX_LENGTH)
    .replace(/[._-]+$/g, '')
}

function tmuxSessionName(projectName) {
  const prefix = normalizeTmuxPrefix(options.tmuxSessionPrefix)
  const name = normalizeProjectName(projectName)
  return name.startsWith(prefix) ? name : `${prefix}${name}`
}

function projectNameFromTmuxSession(sessionName) {
  const prefix = normalizeTmuxPrefix(options.tmuxSessionPrefix)
  return String(sessionName || '').startsWith(prefix)
    ? String(sessionName).slice(prefix.length)
    : String(sessionName || '')
}

function projectNameFromSessionId(sessionId) {
  const value = requiredSessionId(sessionId)
  for (const prefix of sessionPrefixesForProjectDecode()) {
    if (value.startsWith(prefix)) {
      return normalizeProjectName(value.slice(prefix.length))
    }
  }

  try {
    const projectName = normalizeProjectName(value)
    if (projectPathIfExists(projectName)) return projectName
  } catch {}

  const error = new Error('Session does not belong to this VibeTerm server')
  error.status = 400
  throw error
}

function sessionPrefixesForProjectDecode() {
  const currentPrefix = normalizeTmuxPrefix(options.tmuxSessionPrefix)
  return [currentPrefix, ...legacyTmuxSessionPrefixes()].sort((a, b) => b.length - a.length)
}

function legacyTmuxSessionPrefixes() {
  const configured = String(options.tmuxLegacySessionPrefixes || '').trim()
  if (/^(0|false|off)$/i.test(configured)) return []
  if (!configured) return []

  const rawPrefixes = configured.split(/[,\s]+/)
  const currentPrefix = normalizeTmuxPrefix(options.tmuxSessionPrefix)
  const seen = new Set()
  const prefixes = []
  for (const rawPrefix of rawPrefixes) {
    const prefix = normalizeTmuxPrefix(rawPrefix)
    if (prefix === currentPrefix || seen.has(prefix)) continue
    seen.add(prefix)
    prefixes.push(prefix)
  }
  return prefixes
}

function tmuxExecLauncher(cwd) {
  const cd = `cd ${shellQuote(cwd)}`
  if (!options.tmuxRestartExec) {
    return `${cd}; ${options.tmuxExecRow}`
  }

  const delaySeconds = Math.max(0, Number.isFinite(options.tmuxRestartDelay) ? options.tmuxRestartDelay : 2)
  const delay = shellQuote(String(delaySeconds))
  return [
    `${cd}; while :; do ${options.tmuxExecRow}`,
    'code=$?',
    `printf '\\n[VibeTerm] tmux exec row exited with status %s. Restarting in ${delaySeconds}s. Press Ctrl-C to stop.\\n' "$code"`,
    `sleep ${delay}`,
    'done',
  ].join('; ')
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function normalizeTmuxPrefix(value) {
  const prefix = String(value || 'vibeterm-').trim() || 'vibeterm-'
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) return 'vibeterm-'
  return prefix
}

function requiredSessionId(value) {
  const sessionId = String(value || '').trim()
  if (!sessionId) {
    const error = new Error('Missing sessionId')
    error.status = 400
    throw error
  }
  return sessionId
}

function normalizeTmuxKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  const aliases = new Map([
    ['enter', 'Enter'],
    ['return', 'Enter'],
    ['up', 'Up'],
    ['arrowup', 'Up'],
    ['down', 'Down'],
    ['arrowdown', 'Down'],
    ['left', 'Left'],
    ['arrowleft', 'Left'],
    ['right', 'Right'],
    ['arrowright', 'Right'],
    ['tab', 'Tab'],
    ['escape', 'Escape'],
    ['esc', 'Escape'],
    ['backspace', 'BSpace'],
    ['delete', 'Delete'],
    ['del', 'Delete'],
    ['home', 'Home'],
    ['end', 'End'],
    ['pageup', 'PageUp'],
    ['pagedown', 'PageDown'],
    ['c-u', 'C-u'],
    ['ctrl-u', 'C-u'],
    ['ctrlu', 'C-u'],
    ['clearline', 'C-u'],
  ])
  const key = aliases.get(raw)
  if (!key) {
    const error = new Error('Unsupported key')
    error.status = 400
    throw error
  }
  return key
}

function providerFromRequest(request, url) {
  if (url.searchParams.get('provider')) return url.searchParams.get('provider')
  return ''
}

function authorized(request, url) {
  if (!options.projectToken) return true
  const auth = String(request.headers.authorization || '')
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const token = bearer || url.searchParams.get('token') || ''
  return token === options.projectToken
}

async function readJsonBody(request) {
  const body = await readRequestBuffer(request, 1024 * 1024)
  if (!body.length) return {}
  return JSON.parse(body.toString('utf8'))
}

async function handleTranscribe(request, response) {
  try {
    const audio = await readRequestBuffer(request, options.sttMaxBytes)
    if (!audio.length) {
      sendJson(response, 400, { error: 'Empty audio body' })
      return
    }

    const text = await transcribeAudio(audio)
    sendJson(response, 200, { text })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    sendJson(response, status, {
      error: error instanceof Error ? error.message : String(error),
      stt: sttMode(),
    })
  }
}

function readRequestBuffer(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
      request.destroy()
    }

    request.on('data', (chunk) => {
      if (settled) return
      total += chunk.byteLength
      if (total > maxBytes) {
        const error = new Error(`Audio body is too large, max ${maxBytes} bytes`)
        error.status = 413
        fail(error)
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })

    request.on('error', fail)
  })
}

async function transcribeAudio(audio) {
  if (options.sttCommand) {
    return transcribeWithCommand(audio)
  }

  if (process.env.OPENAI_API_KEY) {
    return transcribeWithOpenAI(audio)
  }

  const error = new Error(
    'No STT backend configured. Set OPENAI_API_KEY or VIBETERM_STT_COMMAND before starting the VibeTerm stack.',
  )
  error.status = 501
  throw error
}

async function transcribeWithOpenAI(audio) {
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'g2-voice.wav')
  form.append('model', options.sttOpenaiModel)

  if (process.env.VIBETERM_STT_LANGUAGE) {
    form.append('language', process.env.VIBETERM_STT_LANGUAGE)
  }
  if (process.env.VIBETERM_STT_PROMPT) {
    form.append('prompt', process.env.VIBETERM_STT_PROMPT)
  }

  const response = await fetch(`${options.sttOpenaiBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  })
  const body = await response.text()

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${response.statusText} ${body}`.trim())
  }

  if ((response.headers.get('content-type') || '').includes('json') || body.trim().startsWith('{')) {
    return transcriptFromJson(JSON.parse(body))
  }

  return body.trim()
}

async function transcribeWithCommand(audio) {
  const tempDir = await mkdtemp(join(tmpdir(), 'vibeterm-stt-'))
  const audioPath = join(tempDir, 'input.wav')

  try {
    await writeFile(audioPath, audio)
    const command = options.sttCommand.includes('{file}')
      ? options.sttCommand.replaceAll('{file}', shellQuote(audioPath))
      : `${options.sttCommand} ${shellQuote(audioPath)}`
    const result = await runShell(command, options.sttTimeoutMs)
    return result.stdout.trim()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function runShell(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || 'bash', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`STT command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`STT command exited ${code}: ${stderr || stdout}`.trim()))
      }
    })
  })
}

function runCommand(command, args = [], runOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: runOptions.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeoutMs = runOptions.timeoutMs || 30000
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`.trim()))
      }
    })

    if (runOptions.input !== undefined) {
      child.stdin.end(runOptions.input)
    } else {
      child.stdin.end()
    }
  })
}

function commandOk(command, args = []) {
  return runCommand(command, args).then(() => true, () => false)
}

function commandExists(command) {
  return commandOk(process.env.SHELL || 'bash', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function transcriptFromJson(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''

  for (const key of ['text', 'transcript', 'output', 'result']) {
    const field = value[key]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }

  return ''
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

function sttMode() {
  if (options.sttCommand) return 'command'
  if (process.env.OPENAI_API_KEY) return `openai:${options.sttOpenaiModel}`
  return 'unconfigured'
}
