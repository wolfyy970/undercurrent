// controls.test.ts — the live control plane's route-level contract
// (SPEC-control-plane.md §B Slice A + shared Slice B): 403-before-404,
// identity creation, chat send, thinkers start/stop against the real daemon,
// bad-name validation, config.controls_enabled, and the server's body-size
// cap. No network — everything here is local filesystem + loopback HTTP.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/server.ts";
import { handleMutation, handleGet, type RouterCtx } from "../src/router.ts";
import { scanIdentities, resolveIdentity } from "../src/discovery.ts";
import { resolveIdentityEnv } from "../../../src/identity-env.ts";
import { thinkersStop } from "../../../src/thinkersctl.ts";
import { pidAlive } from "../../../src/runstate.ts";

const roots: string[] = [];

afterEach(async () => {
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
        /* nothing running */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-controls-"));
  roots.push(root);
  return root;
}

function ctxFor(root: string, controlsEnabled = true): RouterCtx {
  return { root, controlsEnabled };
}

async function poll<T>(fn: () => T | undefined, timeoutMs: number, stepMs = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function createIdentity(root: string, name: string): Promise<{ id: string; path: string }> {
  const result = await handleMutation(ctxFor(root), "POST", ["identities"], { name });
  expect(result.status).toBe(201);
  const body = result.body as { ok: boolean; id: string; name: string };
  expect(body.ok).toBe(true);
  const identity = resolveIdentity(root, body.id);
  return { id: body.id, path: identity.path };
}

function rootTrajFilePath(identityPath: string): string {
  const trajRoot = path.join(identityPath, "trajectories");
  const entries = fs.readdirSync(trajRoot).filter((n) => n.endsWith("-root"));
  expect(entries.length).toBe(1);
  return path.join(trajRoot, entries[0]!, "trajectory.jsonl");
}

function readSteps(trajFile: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(trajFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("controls: read-only gating", () => {
  it("403 fires BEFORE the identity 404 — read-only mode never resolves the id", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root, false), "POST", ["identities", "does-not-exist", "chat"], {
      content: "hi",
      from_name: "operator",
    });
    expect(result.status).toBe(403);
    expect((result.body as { detail: unknown }).detail).toBe("Server is read-only");
  });

  it("the SAME missing identity, controls enabled, resolves to a plain 404", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root, true), "POST", ["identities", "does-not-exist", "chat"], {
      content: "hi",
      from_name: "operator",
    });
    expect(result.status).toBe(404);
    expect((result.body as { detail: unknown }).detail).toBe("Identity not found");
  });
});

describe("controls: identity creation", () => {
  it("POST /api/identities -> 201, and GET discovery finds it", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["identities"], { name: "pax" });
    expect(result.status).toBe(201);
    const body = result.body as { ok: boolean; id: string; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("pax");

    const found = scanIdentities(root).find((i) => i.name === "pax");
    expect(found).toBeDefined();
    expect(found!.id).toBe(body.id);

    const getResult = handleGet(ctxFor(root), ["identities"], new URLSearchParams());
    expect(getResult).not.toBeNull();
    const list = getResult!.body as Array<{ name: string }>;
    expect(list.some((i) => i.name === "pax")).toBe(true);
  });

  it("invalid name -> 422, before touching the filesystem", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root), "POST", ["identities"], { name: "Not_Valid!" });
    expect(result.status).toBe(422);
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it("duplicate name -> 409 with message/stderr/exit_code", async () => {
    const root = freshRoot();
    await createIdentity(root, "dup");
    const result = await handleMutation(ctxFor(root), "POST", ["identities"], { name: "dup" });
    expect(result.status).toBe(409);
    const detail = (result.body as { detail: { message: string; stderr: string; exit_code: number } }).detail;
    expect(detail.message).toMatch(/already exists/);
    expect(typeof detail.stderr).toBe("string");
    expect(typeof detail.exit_code).toBe("number");
  });
});

describe("controls: chat", () => {
  it("POST .../chat -> 200 {ok,from,to}, and the message line is appended", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const trajFile = rootTrajFilePath(idPath);
    const before = readSteps(trajFile).length;

    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "chat"], {
      content: "hello there",
      from_name: "operator",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, from: "operator", to: "pax" });

    const after = readSteps(trajFile);
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1]!;
    expect(last["type"]).toBe("message");
    expect(last["content"]).toBe("hello there");
    expect(last["from"]).toBe("operator");
    expect(last["to"]).toBe("pax");
    expect(last["source"]).toBe("chat");
  });

  it("empty content -> 422 'Empty message'", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "chat"], {
      content: "   ",
      from_name: "operator",
    });
    expect(result.status).toBe(422);
    expect((result.body as { detail: unknown }).detail).toBe("Empty message");
  });

  it("invalid from_name -> 422 'Invalid sender name'", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "chat"], {
      content: "hi",
      from_name: "not a name!",
    });
    expect(result.status).toBe(422);
    expect((result.body as { detail: unknown }).detail).toBe("Invalid sender name");
  });

  // PORT-NOTE (1c: f68c1d8): ported from
  // test_thinkers_and_control.py::test_chat_send_passes_slack_source_url.
  it("a Slack source_url is appended to the chat send args and reaches the trajectory", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const trajFile = rootTrajFilePath(idPath);
    const sourceUrl = "https://laudesters.slack.com/archives/C123/p1788451200123456";

    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "chat"], {
      content: "from Slack",
      from_name: "slack-U1-C123",
      source_url: sourceUrl,
    });
    expect(result.status).toBe(200);

    const after = readSteps(trajFile);
    const last = after[after.length - 1]!;
    expect(last["source_url"]).toBe(sourceUrl);
  });

  // PORT-NOTE (1c: f68c1d8): ported from
  // test_thinkers_and_control.py::test_chat_send_validation's added case.
  it("an invalid source_url -> 422 'Invalid source URL'", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "chat"], {
      content: "hi",
      from_name: "nick",
      source_url: "javascript:alert(1)",
    });
    expect(result.status).toBe(422);
    expect((result.body as { detail: unknown }).detail).toBe("Invalid source URL");
  });
});

describe("controls: thinkers start/stop", () => {
  it(
    "start -> 200 and run/dispatcher.pid is alive; stop -> 200 and the pid is gone",
    async () => {
      const root = freshRoot();
      const { id, path: idPath } = await createIdentity(root, "pax");
      const runDir = path.join(idPath, "run");

      const startResult = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "start"], {});
      expect(startResult.status).toBe(200);
      const startBody = startResult.body as { ok: boolean; action: string; names: string[]; exit_code: number };
      expect(startBody.ok).toBe(true);
      expect(startBody.action).toBe("start");
      expect(startBody.names.sort()).toEqual(["monolith", "responder"]);
      expect(startBody.exit_code).toBe(0);

      const pid = Number(fs.readFileSync(path.join(runDir, "dispatcher.pid"), "utf8"));
      expect(pidAlive(pid)).toBe(true);

      const stopResult = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "stop"], {
        force: true,
      });
      expect(stopResult.status).toBe(200);
      expect((stopResult.body as { ok: boolean }).ok).toBe(true);

      await poll(() => (fs.existsSync(path.join(runDir, "dispatcher.pid")) ? undefined : true), 5_000);
      expect(fs.existsSync(path.join(runDir, "dispatcher.pid"))).toBe(false);
      // thinkersStop's SIGKILL escalation doesn't wait to confirm death (it
      // fires-and-forgets after the drain deadline) — poll rather than assert.
      await poll(() => (pidAlive(pid) ? undefined : true), 5_000);
    },
    20_000
  );

  it("no thinkers installed -> 409 'Identity has no thinkers'", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    // Disable every bundled thinker so the identity has none enabled.
    for (const name of fs.readdirSync(path.join(idPath, "thinkers"))) {
      const tdir = path.join(idPath, "thinkers", name);
      if (fs.statSync(tdir).isDirectory()) fs.closeSync(fs.openSync(path.join(tdir, "disabled"), "a"));
    }
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "start"], {});
    expect(result.status).toBe(409);
    expect((result.body as { detail: unknown }).detail).toBe("Identity has no thinkers");
  });

  it("bad thinker names -> 422 (invalid) / 404 (not found)", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");

    const invalid = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "start"], {
      names: ["Not Valid!"],
    });
    expect(invalid.status).toBe(422);
    expect((invalid.body as { detail: unknown }).detail).toBe("Invalid thinker name: Not Valid!");

    const missing = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "start"], {
      names: ["no-such-thinker"],
    });
    expect(missing.status).toBe(404);
    expect((missing.body as { detail: unknown }).detail).toBe("Thinker not found: no-such-thinker");
  });

  it(
    "thinkers/:name/step -> 202 immediately (fire-and-forget)",
    async () => {
      const root = freshRoot();
      const { id } = await createIdentity(root, "pax");
      const started = Date.now();
      const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "monolith", "step"], {});
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.status).toBe(202);
      expect(result.body).toEqual({ ok: true, action: "step", names: ["monolith"] });
    },
    10_000
  );

  it("thinkers/:name/disable then /enable round-trips the marker", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const marker = path.join(idPath, "thinkers", "monolith", "disabled");

    const disableResult = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "monolith", "disable"], {});
    expect(disableResult.status).toBe(200);
    expect(disableResult.body).toEqual({ ok: true, name: "monolith", disabled: true, stopped_first: false });
    expect(fs.existsSync(marker)).toBe(true);

    const enableResult = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinkers", "monolith", "enable"], {});
    expect(enableResult.status).toBe(200);
    expect(enableResult.body).toEqual({ ok: true, name: "monolith", disabled: false, needs_restart: false });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("controls: killall", () => {
  // Fixture ps/docker seams (src/killall.ts's psSnapshot/dockerListing) —
  // see the file header on why every case here goes through fixtures, never
  // a real system-wide `ps`/`docker` scan: killall is deliberately
  // system-wide, so exercising a real default in a test on a shared dev
  // machine risks matching an unrelated live process.

  it("dry_run=true reports fixture ps/docker matches -> 200 {ok,dry_run,stdout,stderr}", async () => {
    const root = freshRoot();
    const ctx: RouterCtx = {
      ...ctxFor(root),
      killallPsSnapshot: () => [{ pid: 424242, ppid: 1, command: "/fake/repo/bin/dispatcherd.mjs" }],
      killallDockerListing: () => ({
        shellmIds: ["deadbeef0001"],
        shellmLines: ["  shellm-424242 (Up 2 minutes)"],
        brokerLines: [],
      }),
    };
    const result = await handleMutation(ctx, "POST", ["killall"], { dry_run: true });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; dry_run: boolean; stdout: string; stderr: string };
    expect(body.ok).toBe(true);
    expect(body.dry_run).toBe(true);
    expect(body.stdout).toContain("Would kill 1 process(es):");
    expect(body.stdout).toContain("Would remove docker container(s):");
    expect(body.stdout).toContain("shellm-424242");
    expect(body.stdout).toContain("nothing was killed");
  });

  it("dry_run=false calls kill on the fixture pid only (mocked — never a real signal)", async () => {
    const root = freshRoot();
    // Mocked so no real signal is ever sent, even to this made-up pid:
    // signal 0 (the liveness poll) reports "gone" so the survivor loop
    // resolves immediately instead of sleeping out its grace period.
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        const e = new Error("ESRCH") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      }
      return true;
    });
    try {
      const ctx: RouterCtx = {
        ...ctxFor(root),
        killallPsSnapshot: () => [{ pid: 424243, ppid: 1, command: "/fake/repo/bin/chat.mjs" }],
        killallDockerListing: () => ({ shellmIds: [], shellmLines: [], brokerLines: [] }),
      };
      const result = await handleMutation(ctx, "POST", ["killall"], { dry_run: false });
      expect(result.status).toBe(200);
      const body = result.body as { ok: boolean; dry_run: boolean; stdout: string };
      expect(body.ok).toBe(true);
      expect(body.dry_run).toBe(false);
      expect(body.stdout).toContain("Killing 1 process(es):");
      expect(killSpy).toHaveBeenCalledWith(424243, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("read-only -> 403, before touching the fixture ps/docker seams", async () => {
    const root = freshRoot();
    let called = false;
    const ctx: RouterCtx = {
      ...ctxFor(root, false),
      killallPsSnapshot: () => {
        called = true;
        return [];
      },
    };
    const result = await handleMutation(ctx, "POST", ["killall"], { dry_run: true });
    expect(result.status).toBe(403);
    expect(called).toBe(false);
  });
});

describe("controls: HTTP server — config + body cap", () => {
  async function withServer<T>(readOnly: boolean, fn: (base: string) => Promise<T>): Promise<T> {
    const root = freshRoot();
    const server = createApiServer({ root, readOnly });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("GET /api/config reports controls_enabled=true by default", async () => {
    await withServer(false, async (base) => {
      const res = await fetch(`${base}/api/config`);
      const body = (await res.json()) as { controls_enabled: boolean };
      expect(body.controls_enabled).toBe(true);
    });
  });

  it("--read-only flips controls_enabled=false and every mutation 403s", async () => {
    await withServer(true, async (base) => {
      const configRes = await fetch(`${base}/api/config`);
      const configBody = (await configRes.json()) as { controls_enabled: boolean };
      expect(configBody.controls_enabled).toBe(false);

      const postRes = await fetch(`${base}/api/identities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "pax" }),
      });
      expect(postRes.status).toBe(403);
    });
  });

  it("a body over 1 MiB is rejected with 413, before any mutation runs", async () => {
    await withServer(false, async (base) => {
      const big = "x".repeat(1024 * 1024 + 1);
      const res = await fetch(`${base}/api/identities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "pax", junk: big }),
      });
      expect(res.status).toBe(413);
    });
  });

  it("malformed JSON -> 400", async () => {
    await withServer(false, async (base) => {
      const res = await fetch(`${base}/api/identities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });

  it("POST /api/killall with a malformed body -> 400 (same body-parse gate, before routing)", async () => {
    await withServer(false, async (base) => {
      const res = await fetch(`${base}/api/killall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });
});
