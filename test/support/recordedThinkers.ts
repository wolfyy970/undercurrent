// recordedThinkers.ts — one LLM_API_URL for a whole dispatched identity (monolith, responder, notes writer), each
// thinker's requests forwarded unchanged to its own recording (test/support/recordedModel.ts). Transport routing only:
// every reply served is a recorded real one. Used by test/live-loop.test.ts and web/server/test/e2e-live.test.ts.
import * as http from "node:http";
import { RECORD_MODEL, recordedModel, type RecordedModel } from "./recordedModel.ts";

const models: RecordedModel[] = [];
const fronts: http.Server[] = [];
/** Close every model and front this module started (call from afterEach). */
export function closeRecordedThinkers(): void {
  while (models.length) models.pop()!.close();
  while (fronts.length) fronts.pop()!.close();
}
/** Which thinker made a request, from its system prompt (the monolith runs shellm; the notes writer and the responder
 *  have their own prompts, src/responder.ts). */
export function callerOf(body: Record<string, unknown>): "monolith" | "notes" | "responder" | "other" {
  const msgs = (body["messages"] as { role: string; content: unknown }[] | undefined) ?? [];
  const sys = msgs.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  if (sys.includes("You are running in shellm")) return "monolith";
  if (/You maintain .*'s private notes/.test(sys)) return "notes";
  if (sys.includes("unconscious thought process of an AI person named")) return "responder";
  return "other";
}
/** One LLM_API_URL for every process: a pass-through front that forwards each request, unchanged, to the recording of
 *  the thinker that made it (transport routing only; every reply is a recorded real one). */
export async function recordedThinkers(lists: Record<"monolith" | "notes" | "responder", RecordedModel>): Promise<Record<string, string>> {
  await Promise.all(Object.values(lists).map((m) => m.ready));
  models.push(...Object.values(lists));
  const front = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", async () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      const who = callerOf(body);
      if (who === "other") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "live-loop: no recording for this caller" } }));
      }
      try {
        const up = await fetch(lists[who].url, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
        res.end(await up.text());
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(e) } }));
      }
    });
  });
  front.unref();
  fronts.push(front);
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  const addr = front.address() as { port: number };
  return {
    LLM_PROVIDER: "openai-compatible",
    LLM_API_URL: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
    LLM_API_KEY: "replay-not-a-key",
    LLM_RETRIES: "0",
    SHELLM_MODEL: RECORD_MODEL,
    THINK_MODEL: RECORD_MODEL,
  };
}


// Steers every monolith wake to idle: the one recorded monolith reply came from this identity text.
export const IDLE_IDENTITY =
  "You are {{identity_name}}, a persistent virtual person in a test. There is nothing to do: no chores, no goals, no " +
  "projects. On every wake, write nothing and finish at once with FINAL=\"idle\".\n";

/** The live-loop recordings: one recorded idle reply, replayed per wake (tests backoff, not content), plus the
 *  responder's and notes writer's real replies to "Please remember teal is my favourite colour." */
export function liveLoopEnv(): Promise<Record<string, string>> {
  return recordedThinkers({
    monolith: recordedModel("live-loop", "monolith-idle", { cycle: true, recordMaxCalls: 1 }),
    responder: recordedModel("live-loop", "responder-teal", { cycle: true, recordMaxCalls: 2 }),
    notes: recordedModel("live-loop", "notes-teal", { cycle: true, recordMaxCalls: 1 }),
  });
}
