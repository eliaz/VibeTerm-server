#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const options = {
  host: process.env.ETERM_UI_HOST || '0.0.0.0',
  port: Number(process.env.ETERM_UI_PORT || 3457),
  file: process.env.ETERM_UI_FILE || 'server/eterm-ui.json',
  sttCommand: process.env.ETERM_STT_COMMAND || '',
  sttMaxBytes: Number(process.env.ETERM_STT_MAX_BYTES || 10 * 1024 * 1024),
  sttOpenaiModel: process.env.ETERM_STT_OPENAI_MODEL || 'gpt-4o-mini-transcribe',
  sttOpenaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  sttTimeoutMs: Number(process.env.ETERM_STT_TIMEOUT_MS || 30000),
  projectToken: process.env.ETERM_PROJECT_TOKEN || '',
  projectsDir: process.env.ETERM_PROJECTS_DIR || '.projects',
  tmuxExecRow: firstEnv('ETERM_TMUX_EXEC_ROW'),
  tmuxSessionPrefix: process.env.ETERM_TMUX_SESSION_PREFIX || 'eventerm-',
  tmuxHistoryLines: Number(process.env.ETERM_TMUX_HISTORY_LINES || 240),
  tmuxBootDelayMs: Number(process.env.ETERM_TMUX_BOOT_DELAY_MS || 1200),
  tmuxRestartExec: firstEnv('ETERM_TMUX_RESTART_EXEC') !== '0',
  tmuxRestartDelay: Number(process.env.ETERM_TMUX_RESTART_DELAY || 2),
  tmuxAutoExport: process.env.ETERM_TMUX_AUTO_EXPORT !== '0',
  tmuxExportBasePort: Number(process.env.ETERM_TMUX_EXPORT_BASE_PORT || 7681),
  tmuxExportDuration: process.env.ETERM_TMUX_EXPORT_DURATION || '6h',
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
    console.error(`eterm-config-server: unknown option ${arg}`)
    process.exit(1)
  }
}

if (!Number.isInteger(options.port) || options.port <= 0) {
  console.error(`eterm-config-server: invalid port ${options.port}`)
  process.exit(1)
}

if (!Number.isFinite(options.sttMaxBytes) || options.sttMaxBytes <= 0) {
  console.error(`eterm-config-server: invalid ETERM_STT_MAX_BYTES ${options.sttMaxBytes}`)
  process.exit(1)
}

if (!Number.isFinite(options.sttTimeoutMs) || options.sttTimeoutMs <= 0) {
  console.error(`eterm-config-server: invalid ETERM_STT_TIMEOUT_MS ${options.sttTimeoutMs}`)
  process.exit(1)
}

if (!options.tmuxExecRow.trim()) {
  console.error('eterm-config-server: set ETERM_TMUX_EXEC_ROW in .env.local, for example:')
  console.error("  ETERM_TMUX_EXEC_ROW='git init >/dev/null 2>&1 || true; codex --yolo --enable use_legacy_landlock'")
  process.exit(1)
}

const uiFile = resolve(options.file)
const projectsDir = resolve(options.projectsDir)
let tmuxEventId = 0

const server = createServer(async (request, response) => {
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      stt: sttMode(),
      tmux: await commandExists('tmux'),
      projectsDir,
    })
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
})

server.listen(options.port, options.host, () => {
  console.log(`Eterm UI config: http://${options.host}:${options.port}/ui.json`)
  console.log(`Eterm STT: http://${options.host}:${options.port}/api/transcribe (${sttMode()})`)
  console.log(`Eterm tmux projects: ${projectsDir}`)
  console.log(`Eterm tmux prefix: ${options.tmuxSessionPrefix}`)
  console.log(`Eterm tmux exec restart: ${options.tmuxRestartExec ? `on after ${options.tmuxRestartDelay}s` : 'off'}`)
  console.log(`Eterm tmux web export: ${options.tmuxAutoExport ? `on from ${options.tmuxExportBasePort}` : 'off'}`)
  console.log(`File: ${uiFile}`)
})

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Eterm-Input-Label')
  response.setHeader('Cache-Control', 'no-store')
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(value)}\n`)
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
      const sessionId = requiredSessionId(url.searchParams.get('sessionId'))
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
      const sessionId = body.sessionId
        ? requiredSessionId(body.sessionId)
        : tmuxSessionName(normalizeProjectName(body.projectName))
      if (!(await tmuxHasSession(sessionId))) {
        if (!body.cwd) {
          const error = new Error(`No tmux project named ${sessionId}`)
          error.status = 404
          throw error
        }
        await ensureTmuxExecSession(sessionId, String(body.cwd), [])
        await delay(options.tmuxBootDelayMs)
      }
      if (text) {
        await sendTextToTmux(sessionId, text)
      }
      sendJson(response, 200, { ok: true, sessionId, provider: 'tmux' })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/key') {
      const body = await readJsonBody(request)
      const sessionId = requiredSessionId(body.sessionId)
      const key = normalizeTmuxKey(body.key)
      await sendKeyToTmux(sessionId, key)
      sendJson(response, 200, { ok: true, sessionId, key })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/interrupt') {
      const body = await readJsonBody(request)
      const sessionId = requiredSessionId(body.sessionId)
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

async function ensureTmuxExecSession(sessionName, cwd, steps = []) {
  if (await tmuxHasSession(sessionName)) {
    steps.push(`tmux session ${sessionName} already running`)
    return
  }

  steps.push(`tmux new-session -d -s ${sessionName}`)
  steps.push(`run ETERM_TMUX_EXEC_ROW in ${relativeProjectPath(cwd)}`)
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

  const child = spawn(
    'timeout',
    [
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
    ],
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
  const sessions = await listTmuxSessions(1000)
  const exports = []

  if (!options.tmuxAutoExport) {
    return {
      enabled: false,
      exportBasePort: options.tmuxExportBasePort,
      exports,
    }
  }

  for (const session of sessions) {
    const exportInfo = await getExistingExport(session.id)
    if (!exportInfo) continue
    exports.push({
      sessionId: session.id,
      projectName: projectNameFromTmuxSession(session.id),
      title: session.title,
      provider: 'tmux',
      status: session.status,
      cwd: session.cwd,
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
  const sessionId = requiredSessionId(url.searchParams.get('sessionId'))
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
  const processes = []
  const seen = new Set()

  for (const line of result.stdout.split('\n')) {
    if (!line.includes(sessionName)) continue
    if (!line.includes('ttyd ') && !line.includes(' timeout ')) continue
    if (!line.includes('titleFixed') && !line.includes('tmux attach')) continue

    const pid = Number(line.trim().split(/\s+/, 1)[0])
    if (!Number.isFinite(pid) || seen.has(pid)) continue
    seen.add(pid)
    processes.push({
      pid,
      port: Number((line.match(/ -p ([0-9]+)/) || [])[1]),
      command: line.trim(),
    })
  }

  return processes
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
  const host = String(requestHost || '').split(':')[0] || 'localhost'
  return `http://${host}:${port}`
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
    return projectPath(name)
  } catch {
    return undefined
  }
}

function relativeProjectPath(projectDir) {
  const rel = relative(process.cwd(), projectDir)
  return rel.startsWith('..') ? projectDir : rel || '.'
}

async function directoryExists(path) {
  return stat(path).then((stats) => stats.isDirectory()).catch(() => false)
}

function normalizeProjectName(value) {
  const name = String(value || '')
    .trim()
    .replace(/\s+/g, '-')
  if (!name || name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    const error = new Error('Use a project name with letters, numbers, dot, dash, or underscore.')
    error.status = 400
    throw error
  }
  return name
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
  const prefix = normalizeTmuxPrefix(options.tmuxSessionPrefix)
  if (!value.startsWith(prefix)) {
    const error = new Error('Session does not belong to this Eventerm server')
    error.status = 400
    throw error
  }
  return normalizeProjectName(value.slice(prefix.length))
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
    `printf '\\n[Eterm] tmux exec row exited with status %s. Restarting in ${delaySeconds}s. Press Ctrl-C to stop.\\n' "$code"`,
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
  const prefix = String(value || 'eventerm-').trim() || 'eventerm-'
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) return 'eventerm-'
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
    'No STT backend configured. Set OPENAI_API_KEY or ETERM_STT_COMMAND before starting the Even stack.',
  )
  error.status = 501
  throw error
}

async function transcribeWithOpenAI(audio) {
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'g2-voice.wav')
  form.append('model', options.sttOpenaiModel)

  if (process.env.ETERM_STT_LANGUAGE) {
    form.append('language', process.env.ETERM_STT_LANGUAGE)
  }
  if (process.env.ETERM_STT_PROMPT) {
    form.append('prompt', process.env.ETERM_STT_PROMPT)
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
  const tempDir = await mkdtemp(join(tmpdir(), 'eterm-stt-'))
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
