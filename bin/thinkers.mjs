#!/bin/sh
":" //; exec "${HEADLONG_TS_RUNTIME:-$(command -v bun || command -v node)}" "$0" "$@"
// bin/thinkers.mjs — `thinkers start|stop|status|step|list|logs` (PLAN-daemon §5).

import "../src/stdioSync.ts"; // first: under Bun, stdout/stderr must not lose bytes on exit
import {
  thinkersStart,
  thinkersStop,
  thinkersStep,
  thinkersList,
  thinkersLogs,
  thinkersStatus,
  thinkersEnable,
  thinkersDisable,
} from "../src/thinkersctl.ts";

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (!cmd) die("Usage: thinkers <start|stop|status|step|list|logs|enable|disable> ...");

// PORT-NOTE (bug #67): no pre-resolution here — matches upstream bin/thinkers,
// which reads its inherited environment as-is and relies entirely on
// `_require_env` (thinkersctl.ts's `requireEnv`) for validation and fallback
// defaults. Previously this unconditionally ran the port's activate-equivalent
// (`resolveIdentityEnv`) whenever IDENTITY_DIR was merely present, which
// synthesized TRAJ_DIR/TRAJ_ID from IDENTITY_DIR even when the caller never
// set them — masking the exact case `requireEnv`'s ordered checks exist to
// catch (IDENTITY_DIR exported by hand, without `identity shell <name>` ever
// having run). Callers that need the activate-equivalent env (this port has
// no separate `identity shell`) build it themselves via `resolveIdentityEnv`
// before invoking these functions — see web/server/src/control.ts,
// parity/{live,replay}'s harnesses, and this file's own tests.
const env = process.env;

try {
  if (cmd === "start") {
    let noSelfTrigger = false;
    const names = [];
    for (const a of argv) {
      if (a === "--no-self-trigger") noSelfTrigger = true;
      else if (a.startsWith("-")) die(`Unknown flag for start: ${a}`);
      else names.push(a);
    }
    const r = await thinkersStart(env, names, { noSelfTrigger, stderr: (s) => process.stderr.write(s) });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } else if (cmd === "stop") {
    let force = false;
    let self = false;
    let drainTimeoutS;
    const names = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--force") force = true;
      else if (a === "--self") self = true;
      else if (a === "--drain-timeout") drainTimeoutS = Number(argv[++i]);
      else if (a.startsWith("-")) die(`stop: unknown option: ${a}`);
      else names.push(a);
    }
    const r = await thinkersStop(env, names, {
      force,
      self,
      ...(drainTimeoutS !== undefined ? { drainTimeoutS } : {}),
      stderr: (s) => process.stderr.write(s),
    });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } else if (cmd === "status") {
    process.stdout.write(thinkersStatus(env));
  } else if (cmd === "step") {
    const name = argv[0];
    if (!name) die("Usage: thinkers step <name>");
    const r = await thinkersStep(env, name, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
    process.exitCode = r.code;
  } else if (cmd === "list") {
    process.stdout.write(`${JSON.stringify(thinkersList(env))}\n`);
  } else if (cmd === "logs") {
    const name = argv[0];
    if (!name) die("Usage: thinkers logs <name>");
    process.stdout.write(thinkersLogs(env, name));
  } else if (cmd === "enable") {
    const name = argv[0];
    if (!name) die("Usage: thinkers enable <name>");
    const r = thinkersEnable(env, name);
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } else if (cmd === "disable") {
    const name = argv[0];
    if (!name) die("Usage: thinkers disable <name>");
    const r = await thinkersDisable(env, name, { stderr: (s) => process.stderr.write(s) });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } else {
    die(`Unknown subcommand: ${cmd}`);
  }
} catch (err) {
  die(`thinkers: error: ${err instanceof Error ? err.message : String(err)}`);
}
