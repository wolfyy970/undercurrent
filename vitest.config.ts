import { defineConfig, defaultExclude } from "vitest/config";

// The daemon lane added several test files that each spawn multiple REAL
// node child processes (dispatcherd, thinker steps, chat) and send them real
// signals, asserting on exact exit codes and timing (test/daemon.test.ts,
// thinkersctl.test.ts, steprun.test.ts, live-loop.test.ts). Running every
// test FILE in parallel (vitest's default) piles all of those processes onto
// the machine at once; under that CPU contention a SIGTERM's exit-code
// assertion occasionally observed a stale/racy result even though the same
// file is 100% reliable run alone. Turning off file-level parallelism trades
// some wall-clock time for determinism — the right trade for a suite whose
// job is partly to prove process lifecycle behavior, not just pure functions.
export default defineConfig({
  test: {
    fileParallelism: false,
    // web/viewer is a vendored React Router SPA with its own vitest.config.ts
    // (vite-tsconfig-paths resolves its "~/..." imports). The root sweep
    // can't resolve those aliases, so it would false-fail files that pass
    // under `npm test` in web/viewer. Run viewer tests there, not here.
    exclude: [...defaultExclude, "web/viewer/**"],
  },
});
