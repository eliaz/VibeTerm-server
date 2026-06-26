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
VIBETERM_TMUX_EXEC_ROW='git init >/dev/null 2>&1 || true; codex --yolo --enable use_legacy_landlock'
```

`VIBETERM_TMUX_EXEC_ROW` is the only command row run inside each new tmux project after the server changes into the project directory. Put any bootstrap work there.

On startup the server prints a setup URL and QR. Set `VIBETERM_PUBLIC_HOST` to the LAN hostname or IP your phone can reach if the detected hostname is not resolvable. For prototype/dev installs, set `VIBETERM_HUB_APP_URL` to the Hub app URL to make the QR open the app with server settings prefilled.

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
