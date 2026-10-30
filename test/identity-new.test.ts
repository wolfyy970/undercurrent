// identity-new.test.ts — `identity new` dir layout + info.txt + 10 seed
// thoughts + bundled thinkers (PLAN-daemon §5).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { identityNew, IDENTITY_NAME_RE } from "../src/identity.ts";
import { readSteps } from "../src/trajCore.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-idnew-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("identity new", () => {
  it("validates the name", () => {
    expect(IDENTITY_NAME_RE.test("pax")).toBe(true);
    expect(IDENTITY_NAME_RE.test("Pax")).toBe(false);
    expect(IDENTITY_NAME_RE.test("-pax")).toBe(false);
    expect(IDENTITY_NAME_RE.test("pax_1")).toBe(false);
  });

  it("refuses an invalid name or an existing dir", () => {
    const root = tmpRoot();
    expect(() => identityNew({ identitiesRoot: root, name: "Bad Name" })).toThrow(/Invalid identity name/);
    identityNew({ identitiesRoot: root, name: "pax" });
    expect(() => identityNew({ identitiesRoot: root, name: "pax" })).toThrow(/already exists/);
  });

  it("creates the full layout: dirs, info.txt, 10 seed thoughts, monolith+responder+retrieval(disabled), no activate", () => {
    const root = tmpRoot();
    const result = identityNew({ identitiesRoot: root, name: "pax" });

    for (const d of ["memories", "skills", "kernel", "trajectories", "thinkers"]) {
      expect(fs.statSync(path.join(result.identityDir, d)).isDirectory()).toBe(true);
    }

    const info = fs.readFileSync(path.join(result.identityDir, "info.txt"), "utf8");
    // tools/identity iso_timestamp: `date +%Y-%m-%dT%H:%M:%S` — LOCAL time,
    // no milliseconds, no `Z`/offset (unlike Date#toISOString()).
    expect(info).toMatch(/^name=pax\ncreated=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\nroot_trajectory=[0-9a-f-]+\n$/);
    expect(info).toContain(`root_trajectory=${result.rootTrajectoryId}`);

    // Root trajectory: genesis + 10 seed thoughts, first is "I am here."
    const hex8 = result.rootTrajectoryId.slice(0, 8);
    const trajFile = path.join(result.identityDir, "trajectories", `${hex8}-root`, "trajectory.jsonl");
    const steps = readSteps(trajFile) as Record<string, unknown>[];
    expect(steps[0]!["type"]).toBe("trajectory");
    const thoughts = steps.filter((s) => s["type"] === "thought");
    expect(thoughts.length).toBe(10);
    expect(thoughts[0]!["content"]).toBe("I am here.");
    expect(thoughts.every((t) => t["source"] === "seed")).toBe(true);

    // Bundled thinkers installed, traj_id injected, step is a Node executable.
    for (const name of ["monolith", "responder", "retrieval"]) {
      const dir = path.join(result.identityDir, "thinkers", name);
      const step = fs.readFileSync(path.join(dir, "step"), "utf8");
      // Bun lane: a sh/JS polyglot launcher that runs $HEADLONG_TS_RUNTIME, else bun, else node (src/runtime.ts)
      expect(step).toMatch(/^#!\/bin\/sh\n":" \/\/; exec "\$\{HEADLONG_TS_RUNTIME:-\$\(command -v bun \|\| command -v node\)\}" "\$0" "\$@"\n/);
      expect(step).not.toMatch(/#!\/bin\/bash/); // the launcher is plain sh and one line; the step itself is JS, never Bash
      const subLine = fs.readFileSync(path.join(dir, "subscriptions.jsonl"), "utf8").trim();
      const sub = JSON.parse(subLine) as Record<string, unknown>;
      expect(sub["traj_id"]).toBe(result.rootTrajectoryId);
    }
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "monolith", "subscriptions.jsonl"))).toBe(true);
    const monoSub = JSON.parse(
      fs.readFileSync(path.join(result.identityDir, "thinkers", "monolith", "subscriptions.jsonl"), "utf8").trim()
    ) as Record<string, unknown>;
    expect(monoSub["types"]).toEqual(["observation", "action", "merge", "monolith-wake"]);
    expect(monoSub["trigger_self"]).toBe(false);

    // retrieval ships disabled; monolith/responder do not.
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "retrieval", "disabled"))).toBe(true);
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "monolith", "disabled"))).toBe(false);
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "responder", "disabled"))).toBe(false);

    // .retired_done lists the six consolidated names.
    const retired = fs.readFileSync(path.join(result.identityDir, "thinkers", ".retired_done"), "utf8");
    expect(retired.split("\n").filter(Boolean).sort()).toEqual(
      ["actor", "goals_manager", "inner_monologue", "learning", "mind_wanderer", "values_manager"].sort()
    );

    // No activate file (DIRECTOR CORRECTION 1).
    expect(fs.existsSync(path.join(result.identityDir, "activate"))).toBe(false);

    // kernel/{mem,chat,goals} + bundled skills/* — copied TEXT (SKILL.md),
    // not symlinked into a Bash checkout (DIRECTOR CORRECTION, item 9).
    for (const skill of ["mem", "chat"]) {
      const md = fs.readFileSync(path.join(result.identityDir, "kernel", skill, "SKILL.md"), "utf8");
      expect(md).toContain("---\nname:");
    }
    for (const skill of ["googleworkspace", "obsidian", "shellm", "skill-author", "slack", "telegram", "web-research"]) {
      expect(fs.existsSync(path.join(result.identityDir, "skills", skill, "SKILL.md"))).toBe(true);
    }

    // retrieval's text assets (prompt.md, stopwords) ARE copied; its Bash
    // indexer is NOT — same for thinkers/_lib/ (Bash-only, never created).
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "retrieval", "prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "retrieval", "stopwords"))).toBe(true);
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "retrieval", "build-index.sh"))).toBe(false);
    expect(fs.existsSync(path.join(result.identityDir, "thinkers", "_lib"))).toBe(false);

    // retrieval's `disabled` marker is upstream's own text, byte-identical.
    // PORT-NOTE (1c: 6c324d1): the marker's wording changed — it is now
    // per-identity state (copied, not a bundled default an update can stomp).
    const disabledText = fs.readFileSync(path.join(result.identityDir, "thinkers", "retrieval", "disabled"), "utf8");
    expect(disabledText).toBe(
      "shipped disabled by default — this marker is copied as per-identity state; delete the identity's copy " +
        "(or use the dashboard) to enable passive memory recall, and updates will preserve that choice\n"
    );

    // subscriptions.jsonl ends with upstream's double-newline quirk (a
    // traj_id-injected line: jq's own \n + the loop's own printf '\n').
    for (const name of ["monolith", "responder", "retrieval"]) {
      const raw = fs.readFileSync(path.join(result.identityDir, "thinkers", name, "subscriptions.jsonl"), "utf8");
      expect(raw.endsWith("}\n\n")).toBe(true);
    }

    // First identity in a fresh root becomes default.
    expect(fs.readlinkSync(path.join(root, "default"))).toBe("pax");
    expect(result.defaultSet).toBe(true);
  });

  it("--memories copies *.md files", () => {
    const root = tmpRoot();
    const memSrc = fs.mkdtempSync(path.join(os.tmpdir(), "headlong-mem-"));
    cleanups.push(() => fs.rmSync(memSrc, { recursive: true, force: true }));
    fs.writeFileSync(path.join(memSrc, "a.md"), "---\nid: a\n---\nnote a\n");
    fs.writeFileSync(path.join(memSrc, "b.md"), "---\nid: b\n---\nnote b\n");
    fs.writeFileSync(path.join(memSrc, "ignore.txt"), "nope");

    const result = identityNew({ identitiesRoot: root, name: "pax", memoriesDir: memSrc });
    expect(result.memoriesImported).toBe(2);
    expect(fs.existsSync(path.join(result.identityDir, "memories", "a.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.identityDir, "memories", "ignore.txt"))).toBe(false);
  });

  it("a second identity does not steal default unless --default", () => {
    const root = tmpRoot();
    identityNew({ identitiesRoot: root, name: "pax" });
    identityNew({ identitiesRoot: root, name: "rin" });
    expect(fs.readlinkSync(path.join(root, "default"))).toBe("pax");

    const r3 = identityNew({ identitiesRoot: root, name: "zed", setDefault: true });
    expect(r3.defaultSet).toBe(true);
    expect(fs.readlinkSync(path.join(root, "default"))).toBe("zed");
  });
});
