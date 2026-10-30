#!/usr/bin/env node
// summarize.mjs <label> — aggregate parity/lostwake/results/<label>-*.json into the table LOSTWAKE.md quotes.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const label = process.argv[2];
const rows = fs.readdirSync(dir).filter((f) => f.startsWith(`${label}-`)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const groups = new Map();
const key = (r) => (r.mode === "none" ? "no restarts" : `${r.mode}, ${r.chaos[0] === 1 ? "aggressive" : r.chaos[0] === 0.5 ? "stress" : "gentle"}`);
const tot = { runs: 0, sent: 0, lost: 0, dup: 0, restarts: 0, downSent: 0, lostDown: 0, lostUp: 0, done: 0, consumed: 0 };
for (const r of rows) {
  const s = r.summary, g = groups.get(key(r)) ?? { runs: 0, sent: 0, lost: 0, dup: 0, restarts: 0 };
  g.runs++; g.sent += s.sent; g.lost += s.never_woken; g.dup += s.duplicate_replies; g.restarts += s.restarts;
  groups.set(key(r), g);
  console.log(`| ${r.tag} | ${r.mode} ${r.chaos.join("-")}s | ${s.restarts} | ${s.sent} | ${s.consumed} | **${s.never_woken}** | ${s.sent_while_dispatcher_down} | ${s.never_woken_while_down} | ${s.never_woken_while_up} | ${s.duplicate_replies} | ${s.receipts_done} |`);
  if (r.mode !== "none") { tot.runs++; tot.sent += s.sent; tot.lost += s.never_woken; tot.dup += s.duplicate_replies; tot.restarts += s.restarts; tot.downSent += s.sent_while_dispatcher_down; tot.lostDown += s.never_woken_while_down; tot.lostUp += s.never_woken_while_up; }
  tot.done += s.receipts_done; tot.consumed += s.consumed;
}
console.log();
for (const [k, g] of groups) console.log(`| ${k} | ${g.runs} | ${g.sent} | ${g.restarts} | ${g.lost} | ${((100 * g.lost) / g.sent).toFixed(1)}% | ${g.dup} |`);
console.log(`\nwith restarts: ${tot.runs} runs, ${tot.sent} messages, ${tot.restarts} restarts, lost ${tot.lost} (${((100 * tot.lost) / tot.sent).toFixed(1)}%), duplicate replies ${tot.dup}; sent while pid down ${tot.downSent} (lost ${tot.lostDown}); lost while pid up ${tot.lostUp}; receipts done ${tot.done}, consumed ${tot.consumed}`);
