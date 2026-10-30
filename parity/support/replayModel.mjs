// parity/support/replayModel.mjs — ONE local replay server that feeds the SAME recorded real model replies to both
// sides of a parity harness (upstream's bash `llm` and the port's `llm`), over each side's real LLM_API_URL path.
//
// Each (scenario, side) gets its own URL: http://127.0.0.1:<port>/r/<scenario>/<side>/v1/chat/completions. Calls are
// numbered per scenario AND per channel (`channelOf(body)`, e.g. "main" vs upstream's extra "summary" call the port
// never makes), so call N of a channel is the same recorded response for both sides, byte for byte.
//
// - Replay (default): call N of a channel is answered with recorded call N; a call with no recording is a MISS
//   (HTTP 400, terminal) and verify() throws.
// - Record (UC_RECORD=1, optional UC_RECORD_ONLY=<regex on "suite/scenario">): a call not yet recorded is forwarded to
//   DeepSeek (UC_RECORD_URL, default its chat/completions) with DEEPSEEK_API_KEY added on the way out (never stored or
//   printed) and saved; a call already recorded (e.g. by the other side) is replayed. So the first side to reach call
//   N records it and the other side gets those exact bytes.
// Files: <dir>/<scenario>.json = { source, provider_url, model, recorded_at, suite, scenario, channels: { <ch>: [ {
// request (the body of the side that recorded it), recorded_by, response {status, content_type, body}, usage,
// usd_upper_bound } ] } }. Nothing here writes model text.
// - Cycle (option `cycle`, labelled in each harness's report): once a channel has a recording, call N past its end is
//   answered with recorded call N mod length, so ONE short real reply can serve every call of that kind. In record
//   mode a cycled channel records only its first call. `recordingOf(scenario)` lets many scenarios share one file.
// - Record guard: a recording file stops recording past `maxRecordCalls` (default 8) calls or `maxRecordUsd` (default
//   $0.008); the call is a miss instead of a provider request. Each harness may set its own limits (startReplay options).
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

export const REPLAY_MODEL = process.env.UC_RECORD_MODEL || "deepseek-flash";
const RECORD_URL = process.env.UC_RECORD_URL || "https://api.deepseek.com/chat/completions";
const USD_IN_MISS = 0.3e-6, USD_IN_HIT = 0.03e-6, USD_OUT = 1.3e-6;

function usageOf(body) {
  let usage;
  for (const line of body.split("\n")) {
    const t = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (j.usage && typeof j.usage === "object") usage = { ...(usage ?? {}), ...j.usage };
    } catch {
      /* not JSON */
    }
  }
  return usage;
}
function usd(u) {
  if (!u) return 0;
  const n = (k) => (typeof u[k] === "number" ? u[k] : 0);
  const hit = n("prompt_cache_hit_tokens");
  const miss = u.prompt_cache_miss_tokens !== undefined ? n("prompt_cache_miss_tokens") : n("prompt_tokens") - hit;
  return miss * USD_IN_MISS + hit * USD_IN_HIT + n("completion_tokens") * USD_OUT;
}

/** Concatenated `delta.content` of a recorded SSE body (or `message.content` of a JSON one). */
export function replyText(body) {
  let t = "";
  for (const line of body.split("\n")) {
    const s = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!s.startsWith("{")) continue;
    try {
      t += JSON.parse(s).choices?.[0]?.delta?.content ?? "";
    } catch {
      /* skip */
    }
  }
  if (t === "") {
    try {
      t = JSON.parse(body).choices?.[0]?.message?.content ?? "";
    } catch {
      /* not JSON */
    }
  }
  return t;
}

export async function startReplay({ suite, dir, channelOf = () => "main", fixtures = {}, forwardModel, cycle = false, recordingOf = (s) => s, callFixtures = {}, maxRecordCalls = 8, maxRecordUsd = 0.008 }) {
  // fixtures[scenario][channel][n] = { status, content_type, body, delayMs? }: an HTTP fixture (transport only: errors,
  // timeouts, an empty or capped stream) served for call n of that channel INSTEAD of a recording; recorded calls fill
  // the other indexes. forwardModel: in record mode, the model name sent to the provider (the side's own name, e.g. a
  // claude-* name that picks the step's text mode, is not a DeepSeek model); the call keeps `forwarded_model`.
  const recordOn = (scenario) => {
    if (process.env.UC_RECORD !== "1") return false;
    const only = process.env.UC_RECORD_ONLY;
    return !only || new RegExp(only).test(`${suite}/${scenario}`);
  };
  const recs = new Map();
  const load = (scenario) => {
    if (!recs.has(scenario)) {
      const f = path.join(dir, `${scenario}.json`);
      recs.set(
        scenario,
        fs.existsSync(f)
          ? JSON.parse(fs.readFileSync(f, "utf8"))
          : { source: "recorded: real provider response, parity/support/replayModel.mjs record mode", provider_url: RECORD_URL, model: REPLAY_MODEL, recorded_at: "", suite, scenario, channels: {} }
      );
    }
    return recs.get(scenario);
  };
  const save = (scenario) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${scenario}.json`), JSON.stringify(recs.get(scenario), null, 1) + "\n");
  };
  const counters = new Map();
  const requests = new Map(); // "<scenario>/<side>" -> [{channel, body}]
  const misses = [];
  const cycled = [];
  const miss = (res, msg) => {
    misses.push(msg);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: msg } }));
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const m = /^\/r\/([^/]+)\/([^/]+)\//.exec(req.url ?? "");
      if (!m) return miss(res, `replay: unroutable path ${req.url}`);
      const scenario = decodeURIComponent(m[1]), side = decodeURIComponent(m[2]);
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep {} */
      }
      const channel = channelOf(body);
      const key = `${scenario}/${side}`;
      if (!requests.has(key)) requests.set(key, []);
      requests.get(key).push({ channel, body });
      const ck = `${key}/${channel}`;
      const idx = counters.get(ck) ?? 0;
      counters.set(ck, idx + 1);
      // callFixtures[scenario][N | "*"]: an HTTP fixture for the scenario+side's N-th call (1-based, all channels).
      const gk = `${key}/*all*`;
      const gn = (counters.get(gk) ?? 0) + 1;
      counters.set(gk, gn);
      const cfx = callFixtures[scenario]?.[gn] ?? callFixtures[scenario]?.["*"];
      if (cfx) {
        counters.set(ck, idx); // a fixture call does not consume a recording index
        res.writeHead(cfx.status, { "content-type": cfx.content_type });
        return res.end(cfx.body);
      }
      const fxs = fixtures[scenario]?.[channel] ?? {};
      const fx = fxs[idx] ?? fxs["*"]; // "*": every call of that channel
      // { recorded: true, delayMs }: a TRANSPORT delay only: hold the response, then serve the RECORDED call as usual.
      if (fx?.recorded) {
        if (fx.delayMs) await new Promise((r) => setTimeout(r, fx.delayMs).unref());
        if (res.destroyed) return;
      } else if (fx) {
        if (fx.delayMs) await new Promise((r) => setTimeout(r, fx.delayMs).unref());
        if (res.destroyed) return;
        res.writeHead(fx.status, { "content-type": fx.content_type });
        return res.end(fx.body);
      }
      const n = idx - Object.keys(fxs).filter((k) => Number(k) < idx && !fxs[k].recorded).length;
      const recName = recordingOf(scenario);
      const rec = load(recName);
      const calls = (rec.channels[channel] ??= []);
      const cyc = typeof cycle === "function" ? cycle(scenario, channel) : cycle;
      if (cyc && calls.length > 0 && !calls[n]) {
        cycled.push(`${key}/${channel}#${n + 1}`);
        const c = calls[n % calls.length];
        res.writeHead(c.response.status, { "content-type": c.response.content_type });
        return res.end(c.response.body);
      }
      if (calls[n]) {
        res.writeHead(calls[n].response.status, { "content-type": calls[n].response.content_type });
        return res.end(calls[n].response.body);
      }
      if (!recordOn(scenario)) return miss(res, `recording miss: ${suite}/${scenario} channel ${channel} has ${calls.length} call(s), ${side} asked for call ${n + 1} (re-record with UC_RECORD=1)`);
      const k = process.env.DEEPSEEK_API_KEY;
      if (!k) return miss(res, `record mode needs DEEPSEEK_API_KEY (${suite}/${scenario})`);
      if (!cyc && n !== calls.length) return miss(res, `record: ${suite}/${scenario} ${channel} call ${n + 1} asked before call ${calls.length + 1} was recorded`);
      const all = Object.values(rec.channels).flat();
      const spent = all.reduce((a, c) => a + (c.usd_upper_bound ?? 0), 0);
      if (all.length >= maxRecordCalls || spent >= maxRecordUsd) return miss(res, `record guard: ${suite}/${recName} already has ${all.length} call(s), $${spent.toFixed(5)} (limits ${maxRecordCalls} calls, $${maxRecordUsd})`);
      try {
        const fwd = forwardModel && body.model !== forwardModel ? JSON.stringify({ ...body, model: forwardModel }) : raw;
        const up = await fetch(RECORD_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k}` }, body: fwd });
        const text = await up.text();
        const ct = up.headers.get("content-type") ?? "application/json";
        const usage = usageOf(text);
        calls.push({ request: body, recorded_by: side, ...(fwd !== raw ? { forwarded_model: forwardModel } : {}), response: { status: up.status, content_type: ct, body: text }, ...(usage ? { usage } : {}), usd_upper_bound: usd(usage) });
        rec.recorded_at_scenario = rec.recorded_at_scenario ?? scenario;
        rec.provider_url = RECORD_URL;
        rec.model = REPLAY_MODEL;
        rec.recorded_at = new Date().toISOString();
        save(recName);
        if (process.env.UC_RECORD_LEDGER) {
          fs.appendFileSync(process.env.UC_RECORD_LEDGER, JSON.stringify({ t: new Date().toISOString(), tag: `uc-rec:${suite}/${scenario}/${channel}#${n + 1}`, usd: usd(usage), usage }) + "\n");
        }
        res.writeHead(up.status, { "content-type": ct });
        res.end(text);
      } catch (e) {
        miss(res, `record: provider call failed for ${suite}/${scenario}: ${e.message}`);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: (scenario, side) => `http://127.0.0.1:${port}/r/${encodeURIComponent(scenario)}/${encodeURIComponent(side)}/v1/chat/completions`,
    requests: (scenario, side) => requests.get(`${scenario}/${side}`) ?? [],
    recording: (scenario) => load(scenario),
    misses,
    cycled,
    verify() {
      if (misses.length) throw new Error(misses.join("\n"));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
