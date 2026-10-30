# UI parity proof — Headlong-TS viewer

**Claim.** The web UI shipped in `web/` renders the Headlong-TS port's data
identically to how the *original* Headlong viewer renders the *same* data.

**How this is proven deterministically.** The viewer is the original Headlong
React app (vendored verbatim from `laude-institute/headlong`, Apache-2.0). Its
routes are pure renderers of a JSON **wire model** fetched from `/api/*` — the
Mind log / Timeline / Mind log v2 all consume one `mindlog` payload
(`NormalizedStep[]` + `RunGroup[]`); Chat consumes a `chat` payload; the status
pill consumes `activity`. Given a fixed trajectory file, that wire model is a
**pure, deterministic function** of the file. So if the port's TypeScript data
layer produces byte-identical wire output to the original Python backend for the
same file, the unchanged React components produce identical DOM.

We therefore assert on the wire model, not on pixels/animations/clocks.

## Method

1. `gen_golden.py` runs the **original** Python viewer backend
   (`headlong/web/src/headlong_web`, unchanged) over pax's real trajectory
   `.identities/pax/trajectories/55fd5932-root` and captures the golden wire
   model: `golden/mindlog.json.gz` (all 1200 steps + 70 runs), `chat.json`,
   `memories.json`, `activity.json`.
2. `verify.ts` runs the **port's** TS data layer (`web/server/src`) over the
   same directory and diffs its output against the golden, canonicalizing
   object key order.
3. Wall-clock-dependent fields (`live` pip, mind-log `mtime`, `last_step_age_s`,
   `cadence_s`, `run_seconds`, `stall_after_s`) are excluded — they depend on
   *when* the server runs, not on the trajectory. Everything derived from the
   file is compared in full, including each step's `raw` record, `preview`,
   `source`, `run_id`, and every run's `step_ids`.

## Result — 11/11 checks pass

```
PASS  mindlog.traj_id
PASS  mindlog.step_count                       (1200)
PASS  mindlog.steps (all 1200, full structure)  <- incl. raw, preview, source, run_id, fork/writeback
PASS  mindlog.runs (all 70 run groups)
PASS  mindlog step-type sequence
PASS  mindlog run_id membership per step
PASS  run grouping (step_ids per run)
PASS  chat.messages                             (18)
PASS  chat.outcomes                             (7: replied / no-reply)
PASS  memories (structure, minus mtime)         (14)
PASS  activity (state=asleep, dispatcher_running, steps_in_flight, ...)
```

The same four comparisons also run inside the unit suite
(`web/server/test/parity.test.ts`), which **skips** (never fakes a pass) if the
`headlong/` sample identities or the captured golden are absent from the
checkout.

## Reproduce

```bash
# 1. (re)capture the golden from the original Python viewer backend
#    (needs the headlong web checkout; no extra Python deps for these paths)
cd parity/ui && ../../../headlong/web/.venv/bin/python gen_golden.py

# 2. run the diff
cd ../.. && node parity/ui/verify.ts   # prints PASS/FAIL per check, exits 1 on mismatch

# 3. or via the unit runner
cd web/server && npm test              # includes parity.test.ts
```

## Honest scope

- This proves **wire-model** parity — the layer the React components render
  from. It is a component-level structural proof, not a headless pixel-diff of
  two running viewers (the original backend is Python/FastAPI + a Bash-run
  dispatcher; standing both stacks up headless to screenshot-diff was neither
  necessary nor honest-cheaper than diffing the model they both render from).
  Visual confirmation that the vendored components render this model was done by
  loading pax in the browser across Mind log, Timeline, Mind log v2, Chat,
  Health, Memories, and Thinkers (see `web/README.md`).
- `activity`/`health` liveness reflects a **static** identity (no running
  dispatcher): state `asleep`, the correct classification for a data directory
  on disk. The reply-pairing "responses" panel is not ported (returns `null`);
  the Health page degrades to "No mind log" for that panel.
