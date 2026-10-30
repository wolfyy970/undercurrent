// e2e-live.test.ts — API-level end-to-end proof of the live control plane,
// NO network: the same deterministic acceptance oracle as test/live-loop.test.ts
// (PLAN-daemon-runtime.md §8), but driven entirely through the web server's
// HTTP surface instead of calling the library directly — POST create ->
// POST thinkers/start -> POST chat -> poll the existing GET endpoints
// (status/activity/mindlog/tree) for the responder reply, the reactive
// monolith wake, and >=2 spontaneous/timer wakes -> POST thinkers/stop.
//
// The model endpoint (LLM_PROVIDER/LLM_API_URL -> recorded real DeepSeek replies, test/support/recordedThinkers.ts: the live-loop recordings)
// + MONOLITH_BACKOFF_HOLD=1 are supplied via the fresh identity's own .env (loaded by resolveIdentityEnv's
// fill-missing layering) rather than mutating this test process's env, since
// the HTTP control-plane surface has no "extra env" parameter — matching how
// an operator would configure a real identity.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/server.ts";
import { resolveIdentityEnv } from "../../../src/identity-env.ts";
import { thinkersStop } from "../../../src/thinkersctl.ts";
import { closeRecordedThinkers, IDLE_IDENTITY, liveLoopEnv } from "../../../test/support/recordedThinkers.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(closeRecordedThinkers); // registered first, so (vitest's stack order) it runs after the thinkers are stopped
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (roots.length) {
    const root = roots.pop()!;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      /* nothing created */
    }
    for (const name of entries) {
      const idDir = path.join(root, name);
      if (!fs.existsSync(path.join(idDir, "info.txt"))) continue;
      try {
        const env = resolveIdentityEnv(idDir, { base: process.env as Record<string, string> });
        await thinkersStop(env, [], { force: true });
      } catch {
        /* nothing running — never leak a dispatcher */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function poll<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs: number, stepMs = 200): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// GET mindlog returns the viewer's NormalizedStep shape (trajectory.ts): a
// handful of top-level fields (type/source/step_id/ts/preview) plus the full
// original JSON under `raw` — `wake`/`from`/`reply_to`/`launched_by` all live
// there, not at the top level.
interface Step {
  type: string;
  raw: Record<string, unknown> | null;
}

describe("e2e-live (HTTP API, recorded replies, no network)", () => {
  it(
    "create -> start -> chat -> responder reply + reactive wake -> >=2 spontaneous wakes -> stop",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-e2e-live-"));
      roots.push(root);

      const server = createApiServer({ root, readOnly: false });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      // Under heavy machine-wide load (a second suite, a live docker session)
      // the loopback TCP connection to this in-process server can get reset
      // before a response ever comes back (ECONNRESET) — a connection-setup
      // failure, not anything about the server's actual behavior. Retry only
      // the connection attempt itself, a bounded number of times; once a
      // response is in hand (any status), it is returned as-is and never
      // retried — a real 4xx/5xx is a result to assert on, not a flake.
      async function connect(url: string, init: RequestInit): Promise<Response> {
        const attempts = 5;
        for (let attempt = 1; ; attempt++) {
          try {
            return await fetch(url, init);
          } catch (err) {
            const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
            const retryable = code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE";
            if (!retryable || attempt >= attempts) throw err;
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
      }

      async function api<T>(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: T }> {
        const res = await connect(`${base}${urlPath}`, {
          method,
          headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: (await res.json()) as T };
      }

      // ---- create ----------------------------------------------------------
      const create = await api<{ ok: boolean; id: string; name: string }>("POST", "/api/identities", { name: "pax" });
      expect(create.status).toBe(201);
      expect(create.body.ok).toBe(true);
      const identityId = create.body.id;
      const idPath = path.join(root, "pax");
      expect(fs.existsSync(path.join(idPath, "info.txt"))).toBe(true);

      // ---- recorded replies, wired through the identity's own .env ---
      // The live-loop recordings: one recorded idle reply, replayed per wake; tests backoff, not content. The identity
      // text is the one those recordings were made with (steered to idle).
      fs.writeFileSync(path.join(idPath, "core_identity_prompt.md"), IDLE_IDENTITY);
      const llmEnv = await liveLoopEnv();
      fs.writeFileSync(
        path.join(idPath, ".env"),
        [
          "SHELLM_SANDBOX=local",
          ...Object.entries(llmEnv).map(([k, v]) => `${k}=${v}`),
          "MONOLITH_BACKOFF_HOLD=1",
          "",
        ].join("\n")
      );

      // ---- start -------------------------------------------------------
      const start = await api<{ ok: boolean; action: string; names: string[]; exit_code: number }>(
        "POST",
        `/api/identities/${identityId}/thinkers/start`,
        {}
      );
      expect(start.status).toBe(200);
      expect(start.body.ok).toBe(true);
      expect(start.body.names.slice().sort()).toEqual(["monolith", "responder"]);
      expect(start.body.exit_code).toBe(0);

      const statusAfterStart = await api<{ live: boolean; pid_alive: boolean }>(
        "GET",
        `/api/identities/${identityId}/status`
      );
      expect(statusAfterStart.body.live).toBe(true);
      expect(statusAfterStart.body.pid_alive).toBe(true);

      // ---- chat send -----------------------------------------------------
      const chat = await api<{ ok: boolean; from: string; to: string }>("POST", `/api/identities/${identityId}/chat`, {
        content: "Please remember teal is my favourite colour, then carry on with whatever you were doing.",
        from_name: "operator",
      });
      expect(chat.status).toBe(200);
      expect(chat.body).toEqual({ ok: true, from: "operator", to: "pax" });

      async function mindlogSteps(): Promise<Step[]> {
        const res = await api<{ steps: Step[] }>("GET", `/api/identities/${identityId}/mindlog?tail=2000`);
        return res.body.steps;
      }

      // ---- responder reply, stamped with reply_to -------------------------
      const replyStepId = await poll(async () => {
        const steps = await mindlogSteps();
        const msg = steps.find((s) => s.type === "message" && s.raw?.["from"] === "pax");
        return msg?.raw?.["reply_to"] as string | undefined;
      }, 15_000);
      expect(typeof replyStepId).toBe("string");
      expect((replyStepId as string).length).toBeGreaterThan(0);

      // ---- reactive monolith wake, triggered by the responder's observation ----
      const reactiveWake = await poll(async () => {
        const steps = await mindlogSteps();
        return steps.find((s) => s.type === "shellm-run" && s.raw?.["wake"] === "reactive/observation:responder");
      }, 15_000);
      expect(reactiveWake.raw?.["launched_by"]).toBe("monolith");

      // ---- >=2 further spontaneous/timer wakes (the mind keeps thinking
      //      on its own, nobody talking to it) -------------------------------
      await poll(async () => {
        const steps = await mindlogSteps();
        const n = steps.filter((s) => s.raw?.["wake"] === "spontaneous/timer").length;
        return n >= 2 ? n : undefined;
      }, 25_000);

      // ---- the backoff level climbs (HOLD=1: boot -> L1, timer -> L2, ...) ----
      // The HTTP surface does not expose the backoff state, so read its on-disk contract
      // (run/monolith_backoff_state.json, written tmp+rename with a trailing newline), as test/live-loop.test.ts does.
      const backoffFile = path.join(idPath, "run", "monolith_backoff_state.json");
      const climbed = await poll(async () => {
        try {
          const raw = fs.readFileSync(backoffFile, "utf8");
          if (!raw.endsWith("\n")) return undefined;
          const j = JSON.parse(raw) as { level: number };
          return j.level >= 2 ? j.level : undefined;
        } catch {
          return undefined;
        }
      }, 25_000);
      expect(climbed).toBeGreaterThanOrEqual(2);

      const finalSteps = await mindlogSteps();
      const timerWakes = finalSteps.filter((s) => s.raw?.["wake"] === "spontaneous/timer");
      expect(timerWakes.length).toBeGreaterThanOrEqual(2);
      // No monolith-wake step was ever appended — synthetic dispatch payload only.
      expect(finalSteps.some((s) => s.type === "monolith-wake")).toBe(false);

      // ---- activity + tree reflect the same live timeline the viewer renders ----
      const activity = await api<{ state: string; dispatcher_running: boolean; steps_in_flight: number }>(
        "GET",
        `/api/identities/${identityId}/activity`
      );
      expect(activity.body.dispatcher_running).toBe(true);
      expect(["idle", "working", "stalled"]).toContain(activity.body.state);

      const tree = await api<{ step_count: number }>("GET", `/api/identities/${identityId}/tree`);
      expect(tree.body.step_count).toBeGreaterThanOrEqual(finalSteps.length);

      // ---- stop --------------------------------------------------------
      const stop = await api<{ ok: boolean }>("POST", `/api/identities/${identityId}/thinkers/stop`, { force: true });
      expect(stop.status).toBe(200);
      expect(stop.body.ok).toBe(true);

      const statusAfterStop = await poll(async () => {
        const res = await api<{ live: boolean; pid_alive: boolean }>("GET", `/api/identities/${identityId}/status`);
        return res.body.pid_alive ? undefined : res.body;
      }, 10_000);
      expect(statusAfterStop.pid_alive).toBe(false);
      expect(fs.existsSync(path.join(idPath, "run", "dispatcher.pid"))).toBe(false);
    },
    60_000
  );
});
