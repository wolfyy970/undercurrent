// src/runtime.ts — which JavaScript runtime the port's own child processes use.
//
// PORT-DEVIATION (Bun lane, PARITY.md "Runtime is Bun"): the port runs on Bun. Every place that spawns one of the port's
// scripts (dispatcher, drain helper, responder notes, skills manager, mem worker) uses the runtime that is running now
// (`process.execPath`: the bun binary under Bun, node under Node) so a parent and its children never mix runtimes. An
// explicit `HEADLONG_TS_RUNTIME=/path/to/bun-or-node` overrides it. The extensionless tool launchers in bin/ and the shipped
// thinker step files pick the runtime the same way: `$HEADLONG_TS_RUNTIME`, else `bun`, else `node` (a sh/JS polyglot first
// line), so a machine or Docker image without Bun still runs the port, on Node.
export function runtimePath(env: Record<string, string | undefined> = process.env): string {
  return env["HEADLONG_TS_RUNTIME"] || process.execPath;
}
