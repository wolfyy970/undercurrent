#!/usr/bin/env node
// run-parser-parity.mjs — recap's reply PARSER, upstream vs port, on literal strings. NO MODEL: these are parser
// comparisons, labelled as such. They replace the old fake `llm` modes that sent hand-written non-JSON "replies"
// (badjson, fenced, null, array, …) over the wire.
//
// Upstream side: the `_llm_json` function, CUT from upstream's bin/recap at run time by stable markers (never a hand
// copy) and checked against a pinned byte length and SHA-256; the harness exits 3 if the markers are missing or the
// cut text changed. It runs in bash with `llm` defined as a function that prints the literal string, so the cut code's
// own fence stripping, `jq -e .` validation and 2-attempt loop decide. Port side: `parseLlmJson` (src/recap.ts), the
// parse half of the port's `_llm_json`. Compared: valid or not, and for a valid one the value (`jq -c .` of upstream's
// output vs the port's jqCompact).
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLlmJson, jqCompact, JsonSeq, splitJsonSeq, parseJsonLossless } from "../../src/recap.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.PARITY_UPSTREAM_ROOT || "/workspace/hlup";
const src = fs.readFileSync(path.join(UPSTREAM, "bin", "recap"), "utf8");
const START = "_llm_json() {\n";
const s = src.indexOf(START);
const e = s < 0 ? -1 : src.indexOf("\n}\n", s);
if (s < 0 || e < 0) {
  console.error("run-parser-parity: _llm_json markers not found in upstream bin/recap");
  process.exit(3);
}
const CUT = src.slice(s, e + 3);
const CUT_BYTES = 1061, CUT_SHA256 = "28d6d5fe67c268c0becfa101fe93e6066fb7d92826c065d9f84bc3770b79ba70";
const sha = crypto.createHash("sha256").update(CUT).digest("hex");
if (process.env.PRINT_CUT_PIN) console.log(Buffer.byteLength(CUT), sha);
if (Buffer.byteLength(CUT) !== CUT_BYTES || sha !== CUT_SHA256) {
  console.error(`run-parser-parity: upstream _llm_json changed (bytes ${Buffer.byteLength(CUT)}, sha256 ${sha}); re-check the cut and re-pin`);
  process.exit(3);
}

const map = '{"title":"t","summary":"s","themes":["x"],"notable_steps":[]}';
const CASES = {
  object: map + "\n",
  badjson: "this is not json\n",
  empty: "",
  "whitespace-only": "   \n\n  \n",
  fenced: "```json\n" + map + "\n```\n",
  "fenced-chatter": "Sure, here you go:\n```json\n" + map + "\n```\nHope that helps!\n",
  null: "null\n",
  false: "false\n",
  array: "[1,2,3]\n",
  string: '"just a string"\n',
  number: "42\n",
  "numlit-episodes": '{"arc":"a","themes":[{"name":"t","description":"d","episodes":[1.0,2,99999999999999999999],"key_steps":[]}]}\n',
  "unicode-and-del": '{"title":"café \u007f  ","summary":"s","themes":["t"],"notable_steps":[]}\n',
  "notable-steps-string": '{"title":"x","summary":"y","themes":[],"notable_steps":"oops"}\n',
  "themes-object": '{"title":"x","summary":"y","themes":{"a":1,"b":2},"notable_steps":[]}\n',
  "step-ids-numbers": '{"summary":"s","themes":[],"step_ids":[1,2]}\n',
  "two-values": '{"a":1}\n{"b":2}\n',
  "trailing-garbage": '{"a":1} x\n',
};

const checks = [];
for (const [name, lit] of Object.entries(CASES)) {
  const script = `${CUT}\nnote() { printf 'recap: %s\\n' "$*" >&2; }\nllm() { cat >/dev/null; printf '%s' "$LIT"; }\nout=$(_llm_json m s u); rc=$?\nprintf '%s\\n' "$rc"\n[ "$rc" = 0 ] && printf '%s' "$out" | jq -c .\n`;
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, LIT: lit, LC_ALL: "C" }, encoding: "utf8" });
  const [rc, ...rest] = r.stdout.split("\n");
  const up = rc === "0" ? `valid ${rest.join("\n").trim()}` : `invalid (rc ${rc})`;
  const v = parseLlmJson(lit);
  const port = v === undefined ? "invalid" : v instanceof JsonSeq ? `valid ${splitJsonSeq(v.text).map((t) => jqCompact(parseJsonLossless(t))).join("\n")}` : `valid ${jqCompact(v)}`;
  const same = up.startsWith("invalid") ? port === "invalid" : up === port;
  checks.push({ name: `parser/${name}`, status: same ? "PARITY" : "DIVERGE", upstream: up, port });
}
const div = checks.filter((c) => c.status !== "PARITY");
for (const c of div) console.log(`DIVERGE ${c.name}\n  upstream: ${c.upstream}\n  port    : ${c.port}`);
console.log(`recap parser parity (no model; upstream _llm_json cut ${CUT_BYTES} B sha256 ${CUT_SHA256.slice(0, 12)}…): ${checks.length - div.length} PARITY, ${div.length} DIVERGE of ${checks.length}`);
fs.writeFileSync(path.join(HERE, "results-parser.json"), JSON.stringify({ upstreamPin: "2e39a3f", cut: { bytes: CUT_BYTES, sha256: CUT_SHA256 }, checks }, null, 1) + "\n");
process.exit(div.length ? 1 : 0);
