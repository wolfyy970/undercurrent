#!/usr/bin/env python3
"""Capture the golden wire model from the ORIGINAL Headlong Python viewer
backend for pax's real trajectory (55fd5932-root), for the UI parity proof.

This runs the upstream normalizer/chat/memories/activity code unchanged
(headlong/web/src/headlong_web), so the golden is exactly what the original
React viewer would have received. verify.ts then reproduces it from the
port's TS data layer and diffs.

Usage (needs the headlong web venv, which has no extra deps for these paths):
    PYTHONPATH=../../../headlong/web/src python3 gen_golden.py
or with the venv:
    ../../../headlong/web/.venv/bin/python gen_golden.py   (adds PYTHONPATH below)
"""

import gzip
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEADLONG = HERE.parents[2] / "headlong"
sys.path.insert(0, str(HEADLONG / "web" / "src"))

from headlong_web import trajectory, chat, memories, activity, discovery  # noqa: E402

IDENTITIES = HEADLONG / ".identities"
OUT = HERE / "golden"
OUT.mkdir(parents=True, exist_ok=True)

identity = discovery.resolve_identity(IDENTITIES, "pax")
traj_dir = discovery.find_root_traj_dir(identity)

# mindlog — whole log via load_trajectory (no cache eviction: deterministic)
loaded = trajectory.load_trajectory(traj_dir)
mindlog = {
    "traj_id": loaded["traj_id"],
    "step_count": loaded["step_count"],
    "steps": loaded["steps"],
    "runs": loaded["runs"],
    "dir_rel": traj_dir.relative_to(identity.path).as_posix(),
}
# mindlog is ~5MB (1200 steps with raw records) — gzip it to keep the repo
# lean; verify.ts / parity.test.ts gunzip on read.
with gzip.open(OUT / "mindlog.json.gz", "wt", encoding="utf-8") as fh:
    json.dump(mindlog, fh, indent=2, sort_keys=True)

# chat
chat_steps = trajectory.CACHE.chat_steps(traj_dir)
view = chat.chat_view(chat_steps, identity.name, tail=200, with_name=None)
(OUT / "chat.json").write_text(json.dumps(view, indent=2, sort_keys=True))

# memories (drop mtime — filesystem clock)
mems = memories.list_memories(identity.path)
for m in mems:
    m.pop("mtime", None)
(OUT / "memories.json").write_text(json.dumps(mems, indent=2, sort_keys=True))

# activity (drop wall-clock-relative fields)
act = activity.identity_activity(identity)
for k in ("last_step_age_s", "run_seconds", "stall_after_s", "cadence_s", "last_step_ts"):
    act.pop(k, None)
(OUT / "activity.json").write_text(json.dumps(act, indent=2, sort_keys=True))

print("golden written:", OUT)
print("  mindlog: steps=%d runs=%d" % (mindlog["step_count"], len(mindlog["runs"])))
print("  chat: messages=%d outcomes=%d" % (len(view["messages"]), len(view["outcomes"])))
print("  memories: %d, activity.state=%s" % (len(mems), act["state"]))
