# Headlong-TS web UI

A runnable web control plane for the Headlong-TS port. It is the **original
Headlong React viewer**, vendored verbatim, wired to a **TypeScript data
layer** that reads the trajectory / rollups / memory files the port writes,
plus a real control API — no Python, no Bash. It renders any trajectory the
engine writes, and — unless started with `--read-only` /
`HEADLONG_READ_ONLY=1` — can also create identities, send chat, and
start/stop/step/enable/disable thinkers, driving a real dispatcher.

```
web/
  viewer/   vendored Headlong React viewer (React Router 7 SPA, unchanged app code)
  server/   thin, dependency-free TS data layer serving the /api the viewer expects
  scripts/  dev + serve orchestrators (zero deps)
```

## Provenance / license

`web/viewer/` is copied from **laude-institute/headlong** (`web/viewer`) at
commit **`5458fee`**, **Apache-2.0**. The upstream license is preserved at
`web/LICENSE`; see `web/NOTICE`. The React components, routes, styling, and
client-side models are upstream and **unmodified** except `viewer/vite.config.ts`
(added a dev `/api` proxy) and `viewer/package.json` (npm scripts + an
`overrides` block for npm-vs-bun installs). Everything under `web/server/`
is new code for this port; each module names the upstream Python module it ports
(`headlong/web/src/headlong_web/*.py`, also Apache-2.0).

## Run it

Prereqs: **Node 22.18+** (built-in type stripping; e.g. `. ~/.nvm/nvm.sh && nvm use 22`). One-time install:

```bash
cd web && npm install          # installs viewer deps (postinstall) ...
cd server && npm install       # ... and the server's dev deps (tsc, vitest)
```

**Dev** (Vite + API, hot reload; Vite proxies `/api` to the server):

```bash
cd web
npm run dev                    # open http://localhost:5273
# defaults to the sibling headlong/.identities (includes the real `pax` identity)
npm run dev -- --root /path/to/your/identities   # point at any serve-root
```

**Production** (build the SPA, serve it + the API from one origin):

```bash
cd web
npm run build                  # -> viewer/build/client
npm run serve -- --root /path/to/identities --port 8787   # http://localhost:8787
# or: npm start   (build + serve)
```

A **serve-root** is a directory that contains identity folders, each an
`info.txt` with a `root_trajectory=` line (e.g. `headlong/.identities`). The
server auto-discovers every identity under it.

The API server can also run standalone: `node web/server/src/index.ts --root <dir> [--port 8787]`.

## Views

A static identity (no dispatcher running) reads as `asleep`, which is correct.

| View                | Status | Notes |
|---------------------|--------|-------|
| **Mind log**        | works  | step-card stream, run grouping, idle folding, source filter, timeline bar |
| **Mind log v2**     | works  | presentation stream (free — same `mindlog` payload) |
| **Timeline**        | works  | swim-lane canvas per thinker (free — same `mindlog` payload) |
| **Chat**            | works  | messages + reply/no-reply outcomes; sending is live (`POST .../chat`) unless the server was started `--read-only` |
| **Health / status** | works  | activity state, cadence, stall threshold, message queue. The reply-pairing "responses" panel is **not ported** (shows "No mind log") |
| **Memories**        | works  | frontmatter + dated-filename parsing |
| **Thinkers**        | works  | per-thinker state/subscriptions/logs; start/stop/step/enable/disable are live (unless `--read-only`) |
| **Mind-log search** | works  | substring scan, thoughts/all scope |
| **Fork tree / sub-trajectory** | works | pax has no forks, so it shows a single root node |
| **Recap**           | subset | `available:false` — the port does not generate `recap/themes.json`; page shows the empty state |
| **Usage**           | subset | `available:false` — the per-day ledger×mindlog merge is not ported; page shows the empty state |
| **Config**          | works  | `controls_enabled` reflects the server's real read-only/enabled state; `git_commit`/`git_branch` are read live from the server's own checkout (`selfUpdate.ts`'s `gitInfo()`); `self_update_enabled` reflects `HEADLONG_WEB_SELF_UPDATE=1` (default off, and always off under `--read-only`) |

## Which routes are real vs. 501

`config.controls_enabled` (from `GET /api/config`) tells the UI whether mutations are allowed at all — it's `false` only when the server was started with `--read-only` / `HEADLONG_READ_ONLY=1`, in which case every mutating route returns **403**. When controls are enabled, every route upstream documents is real and mutates identity/dispatcher state:

- `POST /api/identities` (create)
- `POST /api/identities/:id/chat`
- `POST /api/identities/:id/thinkers/start` / `.../stop`
- `POST /api/identities/:id/thinkers/:name/step`
- `POST /api/identities/:id/thinkers/:name/enable` / `.../disable`
- `POST /api/killall` (wired to `src/killall.ts`, returns `{ok, dry_run, stdout, stderr}`)
- `PUT` / `DELETE /api/identities/:id/env`
- `GET` / `POST /api/identities/:id/thinker-sync`
- `POST /api/identities/:id/recap/refresh` / `.../usage/refresh` (the `GET` **views** for recap/usage are still stubs — `available:false` — see the Views table above; only the refresh actions are real)
- `POST /api/llm-health/probe` (makes one real LLM call)
- `POST /api/identities/import`
- `POST /api/update` (self-update: a real `git pull --ff-only` against the port's own checkout)
- `GET /api/identities/:id/export`, `GET /api/export`, and the export-jobs family (`POST .../export-jobs`, `GET .../export-jobs`, `GET`/`DELETE /api/export-jobs/:job_id`, `GET .../download`) — **not** gated by `_requireControls`, matching upstream
- `GET /api/push/key`, `POST /api/push/subscriptions`, `POST /api/push/unsubscribe` — `GET /api/push/key` is also **not** gated by `_requireControls`, matching upstream

**The 501 list is empty.** `router.ts`'s mutation catch-all (`handleMutation`'s
final branch) is still real code, but it is reachable only by a route this
port has never heard of at all — there is no longer any known upstream route
that falls into it. See `PARITY.md` → "Scope and known gaps" and the "web
control plane" / "identity export" / "web push" / "self-update" module rows
for the source line numbers and differential proof.

## Data layer (`web/server/`)

Dependency-free TypeScript (Node 22.18+ runs `.ts` directly). Ports the upstream
Python normalizer faithfully; the normalized wire model is byte-identical to the
original backend for the same trajectory (see `parity/ui/`).

```bash
cd web/server
npm test            # 211 tests pass, 4 skip (as of 2026-09-02; wire-model parity tests need external pax sample identities)
npm run typecheck   # tsc --noEmit
```

The one intentional simplification: the upstream `TrajectoryCache` is an
append-incremental, memory-bounded parser for 500MB+ mind logs; this port parses
each trajectory whole with a small mtime-invalidated cache (`store.ts`) — the
port's mind logs are small (pax's is ~4.7MB / 1200 steps). Same normalized
output, simpler code.
