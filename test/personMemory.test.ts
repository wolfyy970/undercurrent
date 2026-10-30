// personMemory.test.ts — person/thread key mapping and the `type: person`
// alias merge (design/conversation_memory.md, parts 1+2). Assertions ported
// from upstream's tests/test_chat_history_index.sh (person-key / thread-key
// section) and its "aliases in a person memory merge channels" cases.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  personKey,
  threadKey,
  frontmatterAliases,
  personAliases,
  findPersonMemoryFile,
  notesBody,
  activeGoalsSection,
  relatedMemories,
  memAgeText,
} from "../src/personMemory.js";

describe("personKey", () => {
  it("maps a Slack channel-thread routing name to slack:<user>", () => {
    expect(personKey("slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149")).toBe("slack:U0614H65RN3");
  });
  it("maps a Slack DM routing name to the same key", () => {
    expect(personKey("slack-U0614H65RN3-D0BNW58GP5W")).toBe("slack:U0614H65RN3");
  });
  it("maps a Telegram routing name to telegram:<id>", () => {
    expect(personKey("telegram-8525624593-8525624593")).toBe("telegram:8525624593");
  });
  it("maps a pwa routing name to pwa:<name>", () => {
    expect(personKey("pwa-andy")).toBe("pwa:andy");
  });
  it("leaves a bare name as its own key", () => {
    expect(personKey("Andy")).toBe("Andy");
  });
});

describe("threadKey", () => {
  it("maps a Slack channel-thread routing name to slack-thread:<channel>-<ts>", () => {
    expect(threadKey("slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149")).toBe(
      "slack-thread:C0BMVH6LM4K-1787508187.726149"
    );
  });
  it("is empty for a DM", () => {
    expect(threadKey("slack-U0614H65RN3-D0BNW58GP5W")).toBe("");
  });
  it("is empty for the phone chat", () => {
    expect(threadKey("pwa-andy")).toBe("");
  });
});

describe("frontmatterAliases", () => {
  it("parses the bracket form", () => {
    const content = "---\naliases: [pwa:andy, Andy]\n---\n\nbody\n";
    expect(frontmatterAliases(content)).toEqual(["pwa:andy", "Andy"]);
  });
  it("parses an empty bracket form as []", () => {
    expect(frontmatterAliases("---\naliases: []\n---\n\nbody\n")).toEqual([]);
  });
  it("parses the block-list form", () => {
    const content = "---\naliases:\n  - pwa:andy\n  - Andy\n---\n\nbody\n";
    expect(frontmatterAliases(content)).toEqual(["pwa:andy", "Andy"]);
  });
  it("is [] when absent", () => {
    expect(frontmatterAliases("---\ntype: person\n---\n\nbody\n")).toEqual([]);
  });
});

describe("personAliases + findPersonMemoryFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns just the key when MEM_DIR is unset", () => {
    expect(personAliases(undefined, "slack:U1")).toEqual(["slack:U1"]);
  });

  it("merges a person memory's person_key and aliases when the key matches", () => {
    fs.writeFileSync(
      path.join(dir, "2026-09-02-00-00-00_abcd1234_andy.md"),
      "---\nid: abcd1234\ntype: person\nperson_key: slack:U0614H65RN3\naliases: [pwa:andy, Andy]\nsummary: Andy\n---\n\nAndy prefers short replies.\n"
    );
    const keys = personAliases(dir, "pwa:andy");
    expect(new Set(keys)).toEqual(new Set(["pwa:andy", "slack:U0614H65RN3", "Andy"]));
    const file = findPersonMemoryFile(dir, "pwa:andy");
    expect(file).toBeDefined();
    expect(notesBody(file!.content)).toBe("Andy prefers short replies.\n");
  });

  it("an unrelated key merges nothing beyond itself", () => {
    fs.writeFileSync(
      path.join(dir, "2026-09-02-00-00-00_abcd1234_andy.md"),
      "---\ntype: person\nperson_key: slack:U0614H65RN3\naliases: [pwa:andy]\n---\n\nbody\n"
    );
    expect(personAliases(dir, "Braden")).toEqual(["Braden"]);
    expect(findPersonMemoryFile(dir, "Braden")).toBeUndefined();
  });

  it("ignores non-person memories", () => {
    fs.writeFileSync(
      path.join(dir, "2026-09-02-00-00-00_abcd1234_note.md"),
      "---\ntype: memory\nperson_key: slack:U0614H65RN3\n---\n\nbody\n"
    );
    expect(personAliases(dir, "slack:U0614H65RN3")).toEqual(["slack:U0614H65RN3"]);
  });
});

// PORT-NOTE (1c: 130796a) — ported from upstream's tests/test_related_memories.sh
// (get_goals / _related_memories, thinkers/_lib/common.sh).
describe("activeGoalsSection / relatedMemories (1c: 130796a)", () => {
  const NOW_MS = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00:00Z
  const now = () => NOW_MS;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-related-"));
    const mk = (name: string, type: string, created: string, extra: string, body: string) => {
      fs.writeFileSync(
        path.join(dir, `${name}.md`),
        `---\nid: x\nsummary: s\ntype: ${type}\ncreated: ${created}\n${extra}---\n\n${body}\n`
      );
    };
    mk("2026-08-05-00-00-00_a1_retrieval", "goal", "2026-08-05 00:00:00", "", "Design a retrieval thinker that surfaces memories");
    mk("2026-08-12-00-00-00_b2_prqueue", "todo", "2026-08-12 00:00:00", "until: 2026-08-20\n", "PR queue status, check GitHub access");
    mk("2026-08-29-00-00-00_c3_research", "objective", "2026-08-29 00:00:00", "", "Pursue agent research on spontaneous wakes");
    mk("2026-08-30-00-00-00_c4_intent", "intention", "2026-08-30 00:00:00", "", "Be a useful pragmatic colleague");
    mk("2026-08-31-00-00-00_c5_open", "todo", "2026-08-31 00:00:00", "until: 2999-01-01\n", "Ping Braden about the temporal test");
    mk("2026-09-01-00-00-00_d4_gh", "fact", "2026-09-01 00:00:00", "", "GitHub write for audel on this box: gh is logged in as headlong42, pull-only on laude-institute");
    mk("2026-09-02-00-00-00_e5_nick", "person", "2026-09-02 00:00:00", "", "Nick Jalbert reaches audel via Slack #headlong-bot and DM");
    mk("2026-08-01-00-00-00_f6_arch", "fact", "2026-08-01 00:00:00", "", "audel cognitive architecture: monolith router, responder, thinkers list");
    mk("2026-09-04-00-00-00_g7_fresh", "fact", "2026-09-04 12:00:00", "", "GitHub pull request 108 review comments from Nick, just written");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shows all four goal types", () => {
    const g = activeGoalsSection(dir, { now });
    expect(g).toContain("[goal,");
    expect(g).toContain("[intention,");
    expect(g).toContain("[objective,");
    expect(g).toContain("[todo,");
  });

  it("hides an expired todo", () => {
    expect(activeGoalsSection(dir, { now })).not.toContain("PR queue");
  });

  it("shows an open todo's until date", () => {
    expect(activeGoalsSection(dir, { now })).toContain("until 2999-01-01] Ping Braden");
  });

  it("lists newest first", () => {
    const g = activeGoalsSection(dir, { now });
    expect(g.split("\n")[0]).toContain("Ping Braden");
  });

  it("shows age in weeks for old goals", () => {
    expect(activeGoalsSection(dir, { now })).toMatch(/\[goal, \d+w\] Design a retrieval/);
  });

  it("caps the list and counts the rest", () => {
    const g1 = activeGoalsSection(dir, { max: 1, now });
    expect(g1.match(/^- \[/gm)?.length).toBe(1);
    expect(g1).toContain("and 3 more: mem list");
  });

  it("no goal memories -> (no goals set)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "goals-empty-"));
    try {
      expect(activeGoalsSection(empty, { now })).toBe("(no goals set)");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("picks the GitHub-access note for a PR request, with the first sentence, skipping today's memory", () => {
    const r = relatedMemories(
      dir,
      "PENDING REQUEST from nick: Address Nick's review comments on headlong PR #108 and follow up github pull",
      [],
      { n: 3, now }
    );
    expect(r).toContain("d4_gh [fact, ");
    expect(r).toContain("gh is logged in as headlong42");
    expect(r).not.toContain("g7_fresh"); // written today, skipped
    expect(r.match(/^- /gm)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("skips a memory shown last wake", () => {
    const r2 = relatedMemories(
      dir,
      "Address Nick's review comments on headlong PR #108 github pull",
      ["2026-09-01-00-00-00_d4_gh"],
      { n: 3, now }
    );
    expect(r2).not.toContain("d4_gh");
  });

  it("template words alone produce nothing", () => {
    const r3 = relatedMemories(dir, "(no special signals — pick what best serves the mind right now)", [], { n: 3, now });
    expect(r3).toBe("");
  });

  it("N=0 disables the section", () => {
    const r4 = relatedMemories(dir, "github pull request", [], { n: 0, now });
    expect(r4).toBe("");
  });
});

describe("memAgeText", () => {
  it("formats hours, days, and weeks from a created timestamp", () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    expect(memAgeText("2026-09-04 10:00:00", undefined, now)).toBe("2h");
    expect(memAgeText("2026-09-01 12:00:00", undefined, now)).toBe("3d");
    expect(memAgeText("2026-08-05 00:00:00", undefined, now)).toBe("4w");
  });

  it("falls back to mtime when created is empty or unparseable", () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    const mtime = Date.UTC(2026, 8, 3, 12, 0, 0); // 1 day earlier
    expect(memAgeText("", mtime, now)).toBe("1d");
  });

  it('returns "" when neither created nor mtime is available', () => {
    expect(memAgeText("", undefined, Date.now())).toBe("");
  });
});
