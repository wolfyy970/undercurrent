// Wire-model parity against the golden captured from the original Python
// viewer backend (parity/ui/golden). This asserts the port's TS data layer
// reproduces the exact structure the original React viewer renders, for
// pax's real 1200-step trajectory. Skips (does not fail) if the headlong
// sample identities or the captured golden are not present in this checkout.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { loadTrajectory } from "../src/trajectory.ts";
import { chatView } from "../src/chat.ts";
import { listMemories } from "../src/memories.ts";
import { resolveIdentity, findRootTrajDir } from "../src/discovery.ts";
import { identityActivity } from "../src/liveness.ts";

const REPO = join(import.meta.dirname, "..", "..", ".."); // headlong-ts
const GOLDEN = join(REPO, "parity", "ui", "golden");
const IDENTITIES = join(REPO, "..", "headlong", ".identities");

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
const j = (v: unknown) => JSON.stringify(canon(v));

const available = existsSync(GOLDEN) && existsSync(IDENTITIES);
const d = available ? describe : describe.skip;

d("pax wire-model parity (vs original Python viewer backend)", () => {
  // Load the (external, unshipped) pax trajectory inside beforeAll — NOT at the
  // describe-body top level — so that under describe.skip (sample identities not
  // present, e.g. a standalone checkout) nothing touches the filesystem and the
  // block skips cleanly instead of erroring during collection.
  let identity!: ReturnType<typeof resolveIdentity>;
  let loaded!: ReturnType<typeof loadTrajectory>;
  beforeAll(() => {
    identity = resolveIdentity(IDENTITIES, "pax");
    const trajDir = findRootTrajDir(identity)!;
    loaded = loadTrajectory(trajDir);
  });
  const gold = (name: string) => JSON.parse(readFileSync(join(GOLDEN, name), "utf-8"));
  const goldGz = (name: string) => JSON.parse(gunzipSync(readFileSync(join(GOLDEN, name))).toString("utf-8"));

  it("mindlog: 1200 steps + 70 runs match byte-for-byte", () => {
    const m = goldGz("mindlog.json.gz");
    expect(loaded.traj_id).toBe(m.traj_id);
    expect(loaded.step_count).toBe(m.step_count);
    expect(j(loaded.steps)).toBe(j(m.steps));
    expect(j(loaded.runs)).toBe(j(m.runs));
  });

  it("chat: messages + outcomes match", () => {
    const c = gold("chat.json");
    const v = chatView(loaded.normalizer.chatIndex, identity.name, 200, null);
    expect(j(v.messages)).toBe(j(c.messages));
    expect(j(v.outcomes)).toBe(j(c.outcomes));
  });

  it("memories: structure matches (minus mtime)", () => {
    const mems = listMemories(identity.path).map(({ mtime, ...rest }) => (void mtime, rest));
    expect(j(mems)).toBe(j(gold("memories.json")));
  });

  it("activity: state classification matches", () => {
    const act = identityActivity(identity) as unknown as Record<string, unknown>;
    for (const k of ["last_step_age_s", "run_seconds", "stall_after_s", "cadence_s", "last_step_ts"]) delete act[k];
    expect(j(act)).toBe(j(gold("activity.json")));
  });
});
