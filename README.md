# Eventerm Server

Public server-side companion for the private Eventerm Even Hub app.

It runs on your machine, creates project folders, starts prefixed tmux sessions, serves the editable glasses UI config, exposes tmux snapshots/events to the phone app, and optionally transcribes G2 microphone audio.

## Setup

```bash
cp .env.example .env.local
npm run check
npm start
```

Edit `.env.local` before starting:

```bash
ETERM_PROJECT_TOKEN=change-me
ETERM_PROJECTS_DIR=.projects
ETERM_TMUX_SESSION_PREFIX=eventerm-
ETERM_TMUX_EXEC_ROW='git init >/dev/null 2>&1 || true; codex --yolo --enable use_legacy_landlock'
```

`ETERM_TMUX_EXEC_ROW` is the only command row run inside each new tmux project after the server changes into the project directory. Put any bootstrap work there.

## Endpoints

- `GET /ui.json` serves `server/eterm-ui.json`.
- `GET /api/info?token=...` returns sidecar status.
- `GET /api/sessions?token=...` lists Eventerm tmux sessions.
- `POST /api/projects` creates and optionally launches a project.
- `POST /api/projects/reinitialize` recreates the project tmux session.
- `GET /api/events?sessionId=...&token=...` streams tmux snapshots.
- `POST /api/transcribe` accepts `audio/wav` and returns `{ "text": "..." }`.

## Secrets

Do not commit `.env`, `.env.local`, `.projects`, `.logs`, audio files, or real API keys. Those are gitignored here.
