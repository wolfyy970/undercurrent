// controls-slice-c.test.ts — route-level tests for the Slice C control-plane
// endpoints (SPEC-control-plane.md §B / PARITY.md "web control plane"):
// env PUT/DELETE, thinker-sync, recap/refresh, usage/refresh,
// llm-health/probe. Expectations derived by reading server.py/control.py/
// envfile.py/thinker_sync.py/usage.py/llm_probe directly (see the comment on
// each describe block). No network — local filesystem + injected fetch stubs
// only (no live LLM calls).

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleMutation, handleGet, type RouterCtx } from "../src/router.ts";
import { resolveIdentityEnv } from "../../../src/identity-env.ts";
import { thinkersStop } from "../../../src/thinkersctl.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-slicec-"));
  roots.push(root);
  return root;
}
function ctxFor(root: string, controlsEnabled = true): RouterCtx {
  return { root, controlsEnabled };
}
async function createIdentity(root: string, name: string): Promise<{ id: string; path: string }> {
  const result = await handleMutation(ctxFor(root), "POST", ["identities"], { name });
  expect(result.status).toBe(201);
  const body = result.body as { id: string };
  return { id: body.id, path: path.join(root, name) };
}

// ---------------------------------------------------------------------------
// env (server.py identity_env_get/put/delete, envfile.py)
// ---------------------------------------------------------------------------

describe("env", () => {
  it("GET reflects own + inherited(root) entries, with overridden flag and secret redaction", async () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, ".env"), "SHARED=1\nAPI_KEY=sk-1234567890abcdef\n");
    const { id, path: idPath } = await createIdentity(root, "pax");
    fs.writeFileSync(path.join(idPath, ".env"), "SHARED=2\nOWN=own-value\n");

    const result = handleGet(ctxFor(root), ["identities", id, "env"], new URLSearchParams());
    expect(result).not.toBeNull();
    const body = result!.body as {
      env: { key: string; value: string; secret: boolean }[];
      inherited: { key: string; value: string; secret: boolean; overridden: boolean }[];
      note: string;
    };
    expect(body.env).toEqual(
      expect.arrayContaining([
        { key: "SHARED", value: "2", secret: false },
        { key: "OWN", value: "own-value", secret: false },
      ])
    );
    const sharedInherited = body.inherited.find((e) => e.key === "SHARED")!;
    expect(sharedInherited.overridden).toBe(true);
    const apiKeyInherited = body.inherited.find((e) => e.key === "API_KEY")!;
    expect(apiKeyInherited.secret).toBe(true);
    expect(apiKeyInherited.value).toBe("sk-123…cdef"); // matches envfile.py's redacted_entry peek shape
    expect(apiKeyInherited.overridden).toBe(false);
    expect(body.note).toBe("Changes take effect the next time thinkers are started.");
  });

  it("PUT creates the identity's .env and returns the redacted entry", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "PUT", ["identities", id, "env"], { key: "FOO", value: "bar" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, key: "FOO", value: "bar", secret: false });
    expect(fs.readFileSync(path.join(idPath, ".env"), "utf-8")).toBe("FOO=bar\n");
  });

  it("PUT a secret-shaped key returns the peek, not the raw value, but writes the raw value to disk", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "PUT", ["identities", id, "env"], {
      key: "OPENAI_API_KEY",
      value: "sk-1234567890abcdef",
    });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; key: string; value: string; secret: boolean };
    expect(body.secret).toBe(true);
    expect(body.value).toBe("sk-123…cdef");
    expect(fs.readFileSync(path.join(idPath, ".env"), "utf-8")).toBe("OPENAI_API_KEY=sk-1234567890abcdef\n");
  });

  it("PUT invalid key name -> 422", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "PUT", ["identities", id, "env"], { key: "2BAD", value: "x" });
    expect(result.status).toBe(422);
  });

  it("PUT a multi-line value -> 422 'Value must be a single line'", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "PUT", ["identities", id, "env"], { key: "FOO", value: "line1\nline2" });
    expect(result.status).toBe(422);
    expect((result.body as { detail: string }).detail).toMatch(/single line/);
  });

  it("PUT read-only mode -> 403", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root, false), "PUT", ["identities", id, "env"], { key: "FOO", value: "x" });
    expect(result.status).toBe(403);
  });

  it("DELETE removes an existing var -> 200 {ok,key}, absent -> 404", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    fs.writeFileSync(path.join(idPath, ".env"), "FOO=bar\nBAR=baz\n");

    const result = await handleMutation(ctxFor(root), "DELETE", ["identities", id, "env", "FOO"], {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, key: "FOO" });
    expect(fs.readFileSync(path.join(idPath, ".env"), "utf-8")).toBe("BAR=baz\n");

    const notFound = await handleMutation(ctxFor(root), "DELETE", ["identities", id, "env", "FOO"], {});
    expect(notFound.status).toBe(404);
  });

  it("DELETE invalid key name -> 422", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "DELETE", ["identities", id, "env", "2BAD"], {});
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// thinker-sync (server.py thinker_sync_status/thinker_sync_pull,
// thinker_sync.py)
// ---------------------------------------------------------------------------

describe("thinker-sync", () => {
  it("GET: a freshly-created identity's thinkers are byte-identical to bundled -> all in_sync", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const result = handleGet(ctxFor(root), ["identities", id, "thinker-sync"], new URLSearchParams());
    const body = result!.body as { bundled_root: string | null; thinkers: { name: string; status: string }[] };
    expect(body.bundled_root).not.toBeNull();
    const byName = Object.fromEntries(body.thinkers.map((t) => [t.name, t.status]));
    expect(byName["monolith"]).toBe("in_sync");
    expect(byName["responder"]).toBe("in_sync");
    expect(byName["retrieval"]).toBe("in_sync");
    void idPath;
  });

  it("POST pulls an outdated thinker back in sync, preserving subscriptions.jsonl and the disabled marker", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const stepPath = path.join(idPath, "thinkers", "monolith", "step");
    const subsPath = path.join(idPath, "thinkers", "monolith", "subscriptions.jsonl");
    const originalSubs = fs.readFileSync(subsPath, "utf-8");
    fs.appendFileSync(stepPath, "\n# local drift\n");

    const statusBefore = handleGet(ctxFor(root), ["identities", id, "thinker-sync"], new URLSearchParams());
    const beforeBody = statusBefore!.body as { thinkers: { name: string; status: string }[] };
    expect(beforeBody.thinkers.find((t) => t.name === "monolith")!.status).toBe("outdated");

    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinker-sync"], { names: ["monolith"] });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; results: { name: string; action: string; files: string[] }[] };
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([{ name: "monolith", action: "updated", files: ["step"] }]);

    // subscriptions.jsonl (per-identity state) survives the pull untouched.
    expect(fs.readFileSync(subsPath, "utf-8")).toBe(originalSubs);

    const statusAfter = handleGet(ctxFor(root), ["identities", id, "thinker-sync"], new URLSearchParams());
    const afterBody = statusAfter!.body as { thinkers: { name: string; status: string }[] };
    expect(afterBody.thinkers.find((t) => t.name === "monolith")!.status).toBe("in_sync");
  });

  it("PORT-NOTE (1c: 6c324d1): a fresh install inherits the bundled disabled marker once, then a later pull preserves an operator's removal", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const retrievalDir = path.join(idPath, "thinkers", "retrieval");
    const markerPath = path.join(retrievalDir, "disabled");
    // Simulate "not yet installed" for this identity (a roster addition or a
    // manually-deleted thinker dir) — the fresh-install branch in sync() only
    // fires when status is not_installed.
    fs.rmSync(retrievalDir, { recursive: true, force: true });

    const statusBefore = handleGet(ctxFor(root), ["identities", id, "thinker-sync"], new URLSearchParams());
    const beforeBody = statusBefore!.body as { thinkers: { name: string; status: string }[] };
    expect(beforeBody.thinkers.find((t) => t.name === "retrieval")!.status).toBe("not_installed");

    const first = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinker-sync"], { names: ["retrieval"] });
    expect(first.status).toBe(200);
    const firstBody = first.body as { results: { name: string; action: string }[] };
    expect(firstBody.results).toEqual([{ name: "retrieval", action: "installed", files: expect.any(Array) }]);
    expect(fs.existsSync(markerPath)).toBe(true);
    // The bundled default's own text, byte-identical (test/identity-new.test.ts
    // pins the same string for a fresh `identity new`).
    expect(fs.readFileSync(markerPath, "utf-8")).toBe(
      "shipped disabled by default — this marker is copied as per-identity state; delete the identity's copy " +
        "(or use the dashboard) to enable passive memory recall, and updates will preserve that choice\n"
    );

    // Enabling is an identity choice. A later pull must not restore the
    // bundled default and silently turn the thinker back off.
    fs.rmSync(markerPath);
    const second = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinker-sync"], { names: ["retrieval"] });
    expect(second.status).toBe(200);
    expect(fs.existsSync(markerPath)).toBe(false);
    void idPath;
  });

  it("POST with an invalid thinker name -> 422", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "thinker-sync"], { names: ["Not Valid!"] });
    expect(result.status).toBe(422);
  });

  it("POST read-only mode -> 403", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root, false), "POST", ["identities", id, "thinker-sync"], { names: [] });
    expect(result.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// recap/refresh (server.py identity_recap_refresh, control.py recap_refresh)
// ---------------------------------------------------------------------------

describe("recap/refresh", () => {
  it("202 {ok,action,rebuild}, and it really spawns bin/recap.mjs against this identity's trajectory (proven by the recap/ cache dir it creates, mkdirSync'd before the (short-lived, since there's no LLM configured) .lock — see recap.ts's refresh())", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "recap", "refresh"], { rebuild: false });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, action: "recap-refresh", rebuild: false });

    // No LLM is configured in this test env, so the spawned `recap -q`
    // fails fast (its own reduceThemes call dies) — the acquire/release of
    // recap/.lock happens inside one synchronous library call and is too
    // fast to reliably observe from another process. recap/ itself
    // (mkdirSync'd unconditionally before the lock, in refresh()) persists
    // regardless and is what proves the spawn actually ran.
    const trajRoot = path.join(idPath, "trajectories");
    const trajDirName = fs.readdirSync(trajRoot).find((n) => n.endsWith("-root"))!;
    const recapDir = path.join(trajRoot, trajDirName, "recap");
    const start = Date.now();
    let exists = fs.existsSync(recapDir);
    while (!exists && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 50));
      exists = fs.existsSync(recapDir);
    }
    expect(exists).toBe(true);
  });

  it("409 while a refresh is already running (recap/.lock present)", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const trajRoot = path.join(idPath, "trajectories");
    const trajDirName = fs.readdirSync(trajRoot).find((n) => n.endsWith("-root"))!;
    const lockPath = path.join(trajRoot, trajDirName, "recap", ".lock");
    fs.mkdirSync(lockPath, { recursive: true });

    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "recap", "refresh"], {});
    expect(result.status).toBe(409);
    expect((result.body as { detail: string }).detail).toBe("A recap is already running");
  });

  it("read-only mode -> 403", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root, false), "POST", ["identities", id, "recap", "refresh"], {});
    expect(result.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// usage/refresh (server.py identity_usage_refresh, usage.py start_refresh)
// ---------------------------------------------------------------------------

describe("usage/refresh", () => {
  it("202 {ok,action,rebuild}, and a second concurrent call 409s until the first finishes", async () => {
    const root = freshRoot();
    const { id, path: idPath } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root), "POST", ["identities", id, "usage", "refresh"], { rebuild: true });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, action: "usage-refresh", rebuild: true });

    const result2 = await handleMutation(ctxFor(root), "POST", ["identities", id, "usage", "refresh"], {});
    expect(result2.status).toBe(409);
    expect((result2.body as { detail: string }).detail).toBe("A usage refresh is already running");

    // Let the deferred refresh finish and drop its lock (fast: no LLM calls,
    // pure fs/JSON — see usage.ts's PORT-NOTE on the execution model).
    const trajRoot = path.join(idPath, "trajectories");
    const trajDirName = fs.readdirSync(trajRoot).find((n) => n.endsWith("-root"))!;
    const cachePath = path.join(trajRoot, trajDirName, "usage", "cache.json");
    const start = Date.now();
    while (!fs.existsSync(cachePath) && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(cache.version).toBe(2);
    expect(cache.identity).toBe("pax");
  });

  it("read-only mode -> 403", async () => {
    const root = freshRoot();
    const { id } = await createIdentity(root, "pax");
    const result = await handleMutation(ctxFor(root, false), "POST", ["identities", id, "usage", "refresh"], {});
    expect(result.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// llm-health/probe (server.py llm_probe_endpoint, control.py llm_probe) — no
// live LLM calls: globalThis.fetch is stubbed for the duration of each test.
// ---------------------------------------------------------------------------

describe("llm-health/probe", () => {
  it("success: {ok:true, latency_ms, model, provider} from a stubbed OpenAI-shaped response", async () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, ".env"), "SHELLM_MODEL=gpt-4o-mini\nOPENAI_API_KEY=sk-test\n");
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ id: "x", choices: [{ message: { content: "pong" } }], provider: "openai/gpt-4o-mini" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const result = await handleMutation(ctxFor(root), "POST", ["llm-health", "probe"], {});
      expect(result.status).toBe(200);
      const body = result.body as { ok: boolean; latency_ms: number; model: string | null; provider: string | null };
      expect(body.ok).toBe(true);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.provider).toBe("openai/gpt-4o-mini");
      expect(typeof body.latency_ms).toBe("number");
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("failure: a transport error surfaces {ok:false, error}", async () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, ".env"), "SHELLM_MODEL=gpt-4o-mini\nOPENAI_API_KEY=sk-test\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    try {
      const result = await handleMutation(ctxFor(root), "POST", ["llm-health", "probe"], {});
      expect(result.status).toBe(200); // the PROBE endpoint always 200s; ok:false carries the failure
      const body = result.body as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("read-only mode -> 403", async () => {
    const root = freshRoot();
    const result = await handleMutation(ctxFor(root, false), "POST", ["llm-health", "probe"], {});
    expect(result.status).toBe(403);
  });
});
