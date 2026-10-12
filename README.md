# 📖 OpenReader

A **free, local-first alternative to Readwise + Readwise Reader**. No account,
no subscription, no cloud — your library lives in a SQLite file on your machine.

## Features

- **Save anything** — paste a URL (clean article extraction), write notes, or
  upload PDF / EPUB / HTML / TXT / Markdown
- **Clean reader** — typography-focused reading view with read-progress tracking
- **Highlights** — select text, pick a color, add notes and tags; anchored with
  context so they survive re-renders
- **Spaced review** — daily flashcard-style review of your highlights (Again /
  Good / Easy, SM-2 scheduling), just like Readwise's Daily Review
- **Library** — full-text search, tags, favorites, archive, sort, reading-time
  estimates
- **Import from Readwise** — export your Readwise highlights as CSV and import
  them in one click (Tools → Import / Export)
- **Export anytime** — full backup as JSON, highlights as CSV, or a Markdown digest

## Quick start

```bash
pip install -r requirements.txt
python run.py
```

Opens at `http://127.0.0.1:8765`. Data goes to `./data/openreader.db`
(or `$OPENREADER_DATA` if set).

## Windows `.exe`

See [`desktop/README.md`](desktop/README.md). Push a `v*` tag (or run the
workflow manually) and GitHub Actions builds `OpenReader.exe` for you —
`.github/workflows/build-windows.yml`. The PyInstaller spec
(`OpenReader.spec`) is validated and the bundled app is smoke-tested.

## Android app

See [`android/README.md`](android/README.md): install as a PWA from Chrome
(~1 minute), build a real APK with Bubblewrap, or run fully offline via Termux.

## Project layout

```
backend/app.py        FastAPI API + SQLite (FTS5 search) + extraction
static/               Web UI (index.html, styles.css, app.js) + PWA files
desktop/main.py       pywebview desktop launcher
OpenReader.spec       PyInstaller spec for the Windows .exe
android/              PWA/TWA packaging notes for Android
```

## API

All endpoints under `/api/`: `items` (CRUD, `from-url`, `upload`),
`items/{id}/highlights`, `highlights/{id}`, `review/queue`, `review/grade`,
`tags`, `import/readwise` (CSV), `export?format=json|csv|markdown`, `stats`.

## License

MIT — it's yours.
