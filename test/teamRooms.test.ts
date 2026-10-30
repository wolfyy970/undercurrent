// teamRooms.test.ts — PORT-EXTENSION: group-room routing names (src/personMemory.ts TEAM_ROOM_RE). The responder's history
// for a room post is the sender's own history PLUS the room's thread, the way upstream gives a Slack channel thread its
// context (`slack-<user>-<channel>-<thread_ts>`, bin/chat _thread_key; src/responder.ts queryHistory + buildConvoSel).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { personKey, threadKey } from "../src/personMemory.ts";
import { queryHistory } from "../src/messageIndex.ts";
import { buildConvoSel } from "../src/responder.ts";

describe("room routing names", () => {
  it("person key is the plain sender; thread key is the room", () => {
    expect(personKey("room~den~owner")).toBe("owner");
    expect(threadKey("room~den~owner")).toBe("room:den");
    expect(personKey("room~wren-atlas~atlas")).toBe("atlas"); // room ids may contain '-'
    expect(threadKey("room~wren-atlas~atlas")).toBe("room:wren-atlas");
    expect(threadKey("room~den")).toBe("room:den"); // the room itself: a mind's own post
    expect(threadKey("owner")).toBe("");
    expect(personKey("owner")).toBe("owner");
    expect(threadKey("room~~x")).toBe(""); // malformed: not a room name
  });

  it("a reply to a room post sees the whole room: the other bot's posts and its own, plus the person's direct chat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-rooms-"));
    const idx = path.join(dir, "messages.jsonl");
    const now = Date.parse("2026-10-29T12:00:00Z");
    const at = (m: number) => new Date(now - m * 60_000).toISOString();
    const rows = [
      { step_id: "a1", ts: at(30), from: "owner", to: "wren", content: "direct: I like BBQ" },
      { step_id: "a2", ts: at(20), from: "room~den~owner", to: "wren", content: "(Team: Sam in #Den) Atlas, an activity? Wren, lunch?" },
      { step_id: "a3", ts: at(19), from: "wren", to: "room~den", content: "Lunch: a BBQ place with a private room." },
      { step_id: "a4", ts: at(18), from: "room~den~atlas", to: "wren", content: "(Team: Atlas, a chat bot, not a person in #Den.) A cook-off class." },
      { step_id: "a5", ts: at(10), from: "room~other~atlas", to: "wren", content: "another room" },
      { step_id: "a6", ts: at(1), from: "room~den~owner", to: "wren", content: "(Team: Sam in #Den) What did Atlas suggest?" },
    ];
    fs.writeFileSync(idx, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const from = "room~den~owner";
    const person = queryHistory(idx, { me: "wren", keys: [personKey(from)], threadKey: "", sinceSeconds: 7 * 86400, n: 20, now: () => now });
    const thread = queryHistory(idx, { me: "wren", keys: [], threadKey: threadKey(from), sinceSeconds: 86400, n: 20, now: () => now });
    const turns = buildConvoSel(person, thread, { me: "wren", triggerContent: rows[5]!.content, triggerStepId: "a6", nowMs: now });
    const text = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
    expect(text).toContain("direct: I like BBQ");
    expect(text).toContain("assistant: Lunch: a BBQ place with a private room.");
    expect(text).toContain("A cook-off class.");
    expect(text).not.toContain("another room");
    expect(turns.at(-1)!.content).toContain("What did Atlas suggest?");
    expect(turns.filter((t) => t.content.includes("What did Atlas suggest?"))).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
