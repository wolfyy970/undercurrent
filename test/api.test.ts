// src/api.ts, the public interface: each wrapper behaves as the engine internals it wraps.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../src/api.ts";
import { newTrajectory, readSteps } from "../src/trajCore.mjs";
import { readCursor, writeCursor } from "../src/wakeLedger.ts";
import { FORWARDED_ENV_KEYS } from "../src/sandbox-runtime.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hl-api-"));
const lines = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

function identity() {
  const dir = tmp();
  const { trajId, trajFile } = newTrajectory(path.join(dir, "trajectories"), {}) as { trajId: string; trajFile: string };
  return { dir, trajId, trajFile };
}

describe("public api", () => {
  it("exports only the documented surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      ["API_VERSION", "FORWARDED_ENV_KEYS", "RESPONDER_NOTES_MAX", "appendHistory", "appendStep", "chatHistory", "deliverMessage", "extractCode", "findDelivery", "memoryId", "notesPrompt", "readPersonNote", "resolveIdentityEnv", "rootTrajFile", "runDir", "wakeCursorOffset", "writePersonNote"].sort(),
    );
    expect(api.FORWARDED_ENV_KEYS).toEqual([...FORWARDED_ENV_KEYS]);
  });

  it("package.json exports the api as the package entry point", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { exports: Record<string, string> };
    expect(pkg.exports["."]).toBe("./src/api.ts");
  });

  it("resolveIdentityEnv layers the identity over the given base", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "info.txt"), "name: ann\n");
    const env = api.resolveIdentityEnv(dir, { base: { HOME: dir, KEEP_ME: "1" } });
    expect(env["KEEP_ME"]).toBe("1");
    expect(env["MEM_DIR"]).toBe(path.join(dir, "memories"));
    expect(env["TRAJ_ID"]).toBeTruthy();
  });

  it("rootTrajFile and appendStep agree with the trajectory core", () => {
    const t = identity();
    expect(api.rootTrajFile(t.dir, t.trajId)).toBe(t.trajFile);
    const id = api.appendStep(t.trajFile, { type: "thought", content: "hi" });
    expect((readSteps(t.trajFile) as Record<string, unknown>[]).at(-1)).toMatchObject({ type: "thought", content: "hi", step_id: id });
  });

  it("appendHistory writes chat rows with their own times, oldest first, never twice, and moves a saved cursor past them", () => {
    const t = identity();
    const rd = api.runDir(t.dir);
    writeCursor(rd, { file: t.trajFile, ino: fs.statSync(t.trajFile).ino, offset: 0 });
    const rows: api.HistoryRow[] = [
      { from: "sam", to: "ann", content: "second", ts: "2026-01-01T00:00:02.000Z", key: "m2" },
      { from: "ann", to: "sam", content: "first", ts: "2026-01-01T00:00:01.000Z", key: "m1" },
      { from: "sam", to: "ann", content: "  ", ts: "2026-01-01T00:00:03.000Z", key: "m3" },
    ];
    expect(api.appendHistory(t.dir, t.trajFile, rows)).toBe(2);
    const msgs = lines(t.trajFile).filter((r) => r["type"] === "message");
    expect(msgs.map((m) => [m["content"], m["ts"], m["origin_step_ref"], m["source"]])).toEqual([
      ["first", "2026-01-01T00:00:01.000Z", "m1", "chat"],
      ["second", "2026-01-01T00:00:02.000Z", "m2", "chat"],
    ]);
    expect(readCursor(rd, t.trajFile)?.offset).toBe(fs.statSync(t.trajFile).size);
    expect(api.wakeCursorOffset(t.dir, t.trajFile)).toBe(fs.statSync(t.trajFile).size);
    expect(api.appendHistory(t.dir, t.trajFile, rows)).toBe(0);
    const sid = String(msgs[0]!["step_id"]);
    expect(api.appendHistory(t.dir, t.trajFile, [{ from: "a", to: "b", content: "x", ts: "2026-01-01T00:00:09.000Z", key: "new", alsoKnownAs: [sid] }])).toBe(0);
  });

  it("appendHistory with no saved cursor leaves the run dir alone", () => {
    const t = identity();
    api.appendHistory(t.dir, t.trajFile, [{ from: "sam", to: "ann", content: "x", ts: "2026-01-01T00:00:01.000Z", key: "k" }]);
    expect(readCursor(api.runDir(t.dir), t.trajFile)).toBeNull();
    expect(api.wakeCursorOffset(t.dir, t.trajFile)).toBeNull();
  });

  it("appendHistory redacts a credential value at the write point", () => {
    const t = identity();
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-test-0123456789abcdef0123";
    try {
      api.appendHistory(t.dir, t.trajFile, [{ from: "sam", to: "ann", content: "key sk-test-0123456789abcdef0123", ts: "2026-01-01T00:00:01.000Z", key: "k" }]);
    } finally {
      if (prev === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = prev;
    }
    expect(fs.readFileSync(t.trajFile, "utf8")).not.toContain("sk-test-0123456789abcdef0123");
  });

  it("deliverMessage writes one chat-send-shaped row per (to, originStep), and findDelivery finds it", () => {
    const t = identity();
    const a = api.deliverMessage(t.trajFile, { from: "ann", to: "bob", content: "hello", originStep: "o-1" });
    const b = api.deliverMessage(t.trajFile, { from: "ann", to: "bob", content: "hello", originStep: "o-1" });
    expect(a.written).toBe(true);
    expect(b).toEqual({ stepId: a.stepId, written: false });
    const row = lines(t.trajFile).at(-1)!;
    expect(Object.keys(row)).toEqual(["type", "content", "from", "to", "source", "origin_step_ref", "step_id", "ts"]);
    expect(api.findDelivery(t.trajFile, "bob", "o-1")).toBe(a.stepId);
    expect(api.findDelivery(t.trajFile, "carl", "o-1")).toBeUndefined();
    expect(() => api.deliverMessage(path.join(t.dir, "nope.jsonl"), { from: "a", to: "b", content: "x", originStep: "o" })).toThrow(/does not exist/);
  });

  it("chatHistory sees rows appendHistory wrote", () => {
    const t = identity();
    api.appendHistory(t.dir, t.trajFile, [
      { from: "sam", to: "ann", content: "hi ann", ts: new Date(Date.now() - 2000).toISOString(), key: "a" },
      { from: "ann", to: "sam", content: "hi sam", ts: new Date(Date.now() - 1000).toISOString(), key: "b" },
    ]);
    const h = api.chatHistory(t.trajFile, path.join(t.dir, "messages.jsonl"), { me: "ann", keys: ["sam"] });
    expect(h.map((m) => `${m.from}:${m.content}`)).toEqual(["sam:hi ann", "ann:hi sam"]);
  });

  it("person notes: write creates the responder's format, a rewrite keeps id and created, read returns the body", () => {
    const mem = path.join(tmp(), "memories");
    api.writePersonNote(mem, "sam", "\nlikes tea\nworks late\n\n", { now: new Date(2026, 0, 2, 3, 4, 5).getTime() });
    const [f] = fs.readdirSync(mem);
    expect(f).toMatch(/^2026-01-02-03-04-05_[0-9a-f]{8}_person-sam\.md$/);
    const first = fs.readFileSync(path.join(mem, f!), "utf8");
    expect(first).toMatch(/^---\nid: [0-9a-f]{8}\nsummary: Notes on sam: likes tea\ntype: person\nperson_key: sam\naliases: \[\]\ncreated: 2026-01-02 03:04:05\n---\n\nlikes tea\nworks late\n$/);
    expect(api.readPersonNote(mem, "sam")).toBe("likes tea\nworks late");
    api.writePersonNote(mem, "sam", "drinks coffee now", { displayName: "Sam R" });
    expect(fs.readdirSync(mem)).toEqual([f]);
    const second = fs.readFileSync(path.join(mem, f!), "utf8");
    expect(second).toContain(`id: ${api.memoryId(f!)}\n`);
    expect(second).toContain("summary: Notes on Sam R: drinks coffee now\n");
    expect(second).toContain("created: 2026-01-02 03:04:05\n");
    expect(second).toMatch(/\nupdated: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n/);
    expect(api.readPersonNote(mem, "nobody")).toBe("");
    api.writePersonNote(mem, "sam", "\n\n");
    expect(api.readPersonNote(mem, "sam")).toBe("drinks coffee now");
  });

  it("memoryId, notesPrompt, RESPONDER_NOTES_MAX, extractCode", () => {
    expect(api.memoryId("2026-01-02-03-04-05_0a1b2c3d_goal.md")).toBe("0a1b2c3d");
    expect(api.memoryId("legacy_goal.md")).toBe("");
    expect(api.notesPrompt("Ann", "sam")).toMatch(/^You maintain Ann's private notes about one person they talk with,\nsam\./);
    expect(api.RESPONDER_NOTES_MAX).toBe(40);
    expect(api.extractCode("ok\n```bash\necho hi\n```\n").code).toBe("echo hi");
  });
});
