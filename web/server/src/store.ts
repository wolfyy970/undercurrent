// A tiny per-trajectory parse cache: re-parses only when the file's
// size/mtime changes. The whole-file normalize is cheap for the port's mind
// logs; this just avoids re-parsing on every poll. (The Python backend's
// TrajectoryCache is append-incremental + memory-bounded for 500MB logs;
// this port trades that for simplicity — same normalized output.)

import { statSync } from "node:fs";
import { join } from "node:path";
import { loadTrajectory, type LoadedTrajectory } from "./trajectory.ts";

interface Entry {
  key: string; // `${size}:${mtimeMs}`
  loaded: LoadedTrajectory;
}

const cache = new Map<string, Entry>();

export function getTrajectory(trajDir: string): LoadedTrajectory {
  let key = "0:0";
  try {
    const st = statSync(join(trajDir, "trajectory.jsonl"));
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* missing file -> empty parse */
  }
  const hit = cache.get(trajDir);
  if (hit && hit.key === key) return hit.loaded;
  const loaded = loadTrajectory(trajDir);
  cache.set(trajDir, { key, loaded });
  return loaded;
}
