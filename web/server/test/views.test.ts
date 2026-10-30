import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatView } from "../src/chat.ts";
import { listMemories, readMemory } from "../src/memories.ts";
import { searchSteps } from "../src/search.ts";
import { loadTrajectory } from "../src/trajectory.ts";
import { identityIdFor } from "../src/discovery.ts";

describe("chatView", () => {
  const steps = [
    { type: "human-msg", step_id: "h1", ts: "t1", from: "jo", content: "hello" },
    { type: "agent-msg", step_id: "a1", ts: "t2", to: "jo", content: "hi back", reply_to: "h1" },
    { type: "message", step_id: "m1", ts: "t3", from: "peer", to: "pax", content: "yo" },
    { type: "observation", trigger_step: "m1", decision: "no-reply", content: "" },
  ];
  it("shapes human/agent/message senders and applies identity name", () => {
    const v = chatView(steps, "pax", 200, null);
    expect(v.messages.map((m) => [m.from, m.to, m.content])).toEqual([
      ["jo", "pax", "hello"],
      ["pax", "jo", "hi back"],
      ["peer", "pax", "yo"],
    ]);
  });
  it("records replied + no-reply outcomes keyed by the sent step id", () => {
    const v = chatView(steps, "pax", 200, null);
    expect(v.outcomes).toEqual({ h1: "replied", m1: "no-reply" });
  });
  it("filters by conversation partner via `with`", () => {
    const v = chatView(steps, "pax", 200, "peer");
    expect(v.messages).toHaveLength(1);
    expect(v.messages[0].from).toBe("peer");
  });
  it("tail keeps only the last N messages", () => {
    const v = chatView(steps, "pax", 1, null);
    expect(v.messages).toHaveLength(1);
    expect(v.messages[0].content).toBe("yo");
  });

  // PORT-NOTE (1c: f68c1d8): ported from
  // test_chat_api.py::test_chat_slack_source_url_is_inherited_by_reply.
  it("a reply inherits the Slack source_url of the message it answers", () => {
    const sourceUrl = "https://laudesters.slack.com/archives/C1/p1788451200123456";
    const withSlack = [
      { type: "message", step_id: "m1", ts: "t1", from: "pwa-nick", to: "chatty", content: "hello from phone" },
      { type: "message", step_id: "m3", ts: "t3", from: "slack-U1-C1", to: "chatty", content: "slack says hi", source_url: sourceUrl },
      { type: "message", step_id: "m4", ts: "t4", from: "chatty", to: "slack-U1-C1", content: "hi slack", reply_to: "m3" },
    ];
    const v = chatView(withSlack, "chatty", 200, null);
    const byId = Object.fromEntries(v.messages.map((m) => [m.step_id, m]));
    expect(byId["m3"]!.source_url).toBe(sourceUrl);
    expect(byId["m4"]!.source_url).toBe(sourceUrl);
    expect(byId["m1"]!.source_url).toBeNull();
  });
});

describe("listMemories", () => {
  const dir = mkdtempSync(join(tmpdir(), "hl-ident-"));
  mkdirSync(join(dir, "memories"));
  writeFileSync(
    join(dir, "memories", "2026-08-28-11-55-24_0c5fbd78_i-am-curious.md"),
    "---\nid: 0c5fbd78\nsummary: I am curious\ntype: trait\n---\nbody\n",
  );
  writeFileSync(join(dir, "memories", "legacy-note.md"), "no frontmatter here\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parses frontmatter fields and dated filename metadata", () => {
    const mems = listMemories(dir);
    const m = mems.find((x) => x.name.startsWith("2026-08-28"))!;
    expect(m.id).toBe("0c5fbd78");
    expect(m.summary).toBe("I am curious");
    expect(m.type).toBe("trait");
    expect(m.slug).toBe("i-am-curious");
    expect(m.created).toBe("2026-08-28 11:55:24");
  });
  it("falls back to filename for legacy files, never crashing", () => {
    const mems = listMemories(dir);
    const legacy = mems.find((x) => x.name === "legacy-note.md")!;
    expect(legacy.type).toBe("memory");
    expect(legacy.slug).toBe("legacy-note");
  });
  it("readMemory returns content and refuses traversal", () => {
    expect(readMemory(dir, "legacy-note.md")).toContain("no frontmatter");
    expect(readMemory(dir, "../info.txt")).toBeNull();
  });
});

describe("searchSteps", () => {
  const dir = mkdtempSync(join(tmpdir(), "hl-search-"));
  writeFileSync(
    join(dir, "trajectory.jsonl"),
    [
      { type: "thought", source: "monolith", step_id: "t1", ts: "1", content: "the weather is nice" },
      { type: "reasoning", step_id: "r1", ts: "2", run_id: "x", thought: "weather check", cmd: "curl weather" },
      { type: "message", source: "chat", step_id: "m1", ts: "3", from: "jo", content: "hello weather" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  const loaded = loadTrajectory(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("scope=thoughts skips run machinery (reasoning)", () => {
    const res = searchSteps(loaded.steps, "weather", "thoughts", 50);
    const types = res.hits.map((h) => h.type).sort();
    expect(types).toEqual(["message", "thought"]);
    expect(res.total).toBe(2);
  });
  it("scope=all includes machinery and returns newest-first", () => {
    const res = searchSteps(loaded.steps, "weather", "all", 50);
    expect(res.total).toBe(3);
    // newest first: message (idx 2), reasoning (idx 1), thought (idx 0)
    expect(res.hits.map((h) => h.index)).toEqual([2, 1, 0]);
  });
  it("names the matched field", () => {
    const res = searchSteps(loaded.steps, "curl weather", "all", 50);
    expect(res.hits[0].field).toBe("cmd");
  });
});

describe("identityIdFor", () => {
  it("maps nested paths to ~-joined ids", () => {
    expect(identityIdFor("pax")).toBe("pax");
    expect(identityIdFor("improve/generations/gen-001/identities/run")).toBe(
      "improve~generations~gen-001~identities~run",
    );
  });
});
