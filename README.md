# VibeTerm Server

Public server-side companion for the private VibeTerm Even Hub app.

It runs on your machine, creates project folders, starts prefixed tmux sessions, serves the editable glasses UI config, exposes tmux snapshots/events to the phone app, and optionally transcribes G2 microphone audio.

## Setup

```bash
cp .env.example .env.local
npm install
npm run check
npm start
```

Edit `.env.local` before starting:

```bash
VIBETERM_PROJECT_TOKEN=change-me
VIBETERM_PROJECTS_DIR=.projects
VIBETERM_TMUX_SESSION_PREFIX=vibeterm-
VIBETERM_TMUX_EXEC_ROW='git init >/dev/null 2>&1 || true; codex --resume --yolo --enable use_legacy_landlock'
VIBETERM_TLS=0
```

`VIBETERM_TMUX_EXEC_ROW` is the only command row run inside each new tmux project after the server changes into the project directory. Put any bootstrap work there.

VibeTerm treats disk/process state as truth:

- Projects are folders under `VIBETERM_PROJECTS_DIR`.
- Open terminals are running tmux sessions with `VIBETERM_TMUX_SESSION_PREFIX`.
- Web exports are running `ttyd`/`timeout` processes for those tmux sessions.

TLS is off by default because the Even Hub app/WebView may reject local self-signed certificates. Use HTTP over a private LAN/VPN such as Tailscale for the normal setup.

If you have a trusted certificate or trusted reverse proxy/tunnel, set `VIBETERM_TLS=1`. If `VIBETERM_TLS_CERT` and `VIBETERM_TLS_KEY` are missing, the server creates local self-signed certs under `.certs/`, but those dummy certs are not expected to work reliably in the Hub app.

To expose tmux projects in a laptop browser, set `VIBETERM_TMUX_AUTO_EXPORT=1`. This starts plain HTTP `ttyd` exports from `VIBETERM_TMUX_EXPORT_BASE_PORT` for new/reinitialized projects. Treat it as very insecure: use only on a trusted LAN/VPN such as Tailscale, and leave it off otherwise.

On startup the server prints a setup URL. Set `VIBETERM_PUBLIC_HOST` to the LAN hostname or IP your phone can reach if the detected hostname is not resolvable. Paste the printed URL into VibeTerm Settings -> Load Settings From URL.

## Endpoints

- `GET /ui.json` serves `server/vibeterm-ui.json`.
- `GET /setup?token=...` shows runtime settings for the Hub app.
- `GET /setup.json?token=...` returns those settings as JSON.
- `GET /api/info?token=...` returns sidecar status.
- `GET /api/sessions?token=...` lists VibeTerm tmux sessions.
- `POST /api/projects` creates and optionally launches a project.
- `POST /api/projects/reinitialize` recreates the project tmux session.
- `GET /api/events?sessionId=...&token=...` streams tmux snapshots.
- `POST /api/transcribe` accepts `audio/wav` and returns `{ "text": "..." }`.

## Secrets

Do not commit `.env`, `.env.local`, `.projects`, `.logs`, audio files, or real API keys. Those are gitignored here.
