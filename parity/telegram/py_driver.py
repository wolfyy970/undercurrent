#!/usr/bin/env python3
"""py_driver.py — drives the real Python bridge's Inbound/outbound.run
against the fake server for one parity scenario. See run-parity.mjs's header
for the full harness design.

Usage: python3 py_driver.py <spec.json>
(run via `uv run --project <clone>/telegram python3 py_driver.py <spec.json>`
so `headlong_telegram` and httpx resolve from that project's venv — never
modifies the oracle checkout.)

Reads the scenario spec, does the work, exits 0/1. On-disk state and the fake
server's recorded requests are read directly by run-parity.mjs (same
machine, same files) — this driver reports nothing but exit status.

The Telegram Bot API is a hardcoded host (api.telegram.org) in the oracle's
api.py, with no override seam — same technique the oracle's OWN
tests/test_api.py and tests/test_inbound.py already use to reach it
deterministically: swap `Bot._client` for an `httpx.Client` running an
`httpx.MockTransport`. Here the transport handler RELAYS every request to the
fake server over a real HTTP call (preserving method/headers/body), rather
than answering in-process, so the fake server actually receives and records
the same bytes the TS port's injected fetchImpl sends it.
"""

import json
import pathlib
import sys
import traceback

import httpx

from headlong_telegram.config import Config
from headlong_telegram.api import Bot
from headlong_telegram.allowlist import Allowlist
from headlong_telegram.inbound import Inbound
from headlong_telegram import outbound


def make_relay(port: int):
    # Generous timeout: this relay hop is localhost-only and should be near
    # instant, but the harness may share a machine with other concurrent
    # work, and httpx's 5s default has been observed to trip under load.
    real_client = httpx.Client(timeout=30)

    def relay(request: httpx.Request) -> httpx.Response:
        url = f"http://127.0.0.1:{port}{request.url.raw_path.decode()}"
        r = real_client.request(
            request.method, url, headers=request.headers, content=request.content
        )
        return httpx.Response(r.status_code, headers=r.headers, content=r.content)

    return relay


def seed_allowlist(state_dir: pathlib.Path, seed) -> None:
    if seed is None:
        return
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "allowlist.json").write_text(json.dumps(seed, indent=2))


class CountingStop:
    """A `threading.Event`-shaped stop signal, duck-typed: `.is_set()` returns
    False on its first `allow` calls (let one read/poll pass through), True
    after. 2e39a3f: outbound.run now checks the event once in its own retry
    loop before mindlog.follow checks it, so the outbound drivers pass
    allow=2 (one for the loop, one for the follow's first poll)."""

    def __init__(self, allow: int = 1):
        self.n = 0
        self.allow = allow

    def is_set(self) -> bool:
        stop = self.n >= self.allow
        self.n += 1
        return stop


def main(spec: dict) -> None:
    sandbox = pathlib.Path(spec["sandbox"])
    identity_dir = sandbox / ".identities" / spec["cfg"]["identity"]
    state_dir = sandbox / "state"
    identity_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    cfg = Config(
        serve_root=sandbox,
        identity=spec["cfg"]["identity"],
        identity_dir=identity_dir,
        bot_token=spec["cfg"]["botToken"],
        admin_id=spec["cfg"]["adminId"],
        web_url=f"http://127.0.0.1:{spec['port']}",
        state_dir=state_dir,
    )
    seed_allowlist(state_dir, spec.get("seedAllowlist"))

    bot = Bot(cfg.bot_token)
    bot._client = httpx.Client(
        transport=httpx.MockTransport(make_relay(spec["port"])), timeout=30
    )
    allowlist = Allowlist(state_dir / "allowlist.json")

    mode = spec["mode"]
    if mode == "handle":
        ib = Inbound(cfg, bot, allowlist)
        for update in spec["updates"]:
            ib._handle(update)
        return

    if mode == "run-poll":
        ib = Inbound(cfg, bot, allowlist)
        calls = {"n": 0}

        def should_stop():
            stop = calls["n"] >= spec["stopAfter"]
            calls["n"] += 1
            return stop

        ib.run(should_stop)
        return

    if mode == "outbound":
        traj_dir = identity_dir / "trajectories" / "12345678-root"
        traj_dir.mkdir(parents=True, exist_ok=True)
        traj_file = traj_dir / "trajectory.jsonl"
        # Compact separators (no spaces): match JS `JSON.stringify`'s default
        # byte-for-byte, so both drivers seed an identical trajectory file
        # and the `cursor` byte-offset comparison is meaningful. (Python's
        # `json.dumps` default separators are `(", ", ": ")` — WITH spaces —
        # which would make the two seed files different lengths for no
        # reason related to either bridge's own behavior.)
        lines = [json.dumps(s, separators=(",", ":")) for s in spec["seedTrajectorySteps"]]
        traj_file.write_text("\n".join(lines) + "\n")
        (identity_dir / "info.txt").write_text(
            f"name={spec['cfg']['identity']}\n"
            "root_trajectory=12345678-1111-2222-3333-444455556666\n"
        )
        if spec.get("seedCursorOffsetZero"):
            (state_dir / "cursor").write_text("0")

        if spec.get("seedCursorRaw") is not None:
            (state_dir / "cursor").write_text(spec["seedCursorRaw"].replace("<SANDBOX>", str(sandbox)))
        # 2e39a3f: delivery notices -> a sink file (production: bin/traj); the
        # notice the bridge BUILT is compared. Same seam upstream's conftest uses.
        notices_file = sandbox / "notices.jsonl"

        def collect(serve_root, traj_path, step):
            with notices_file.open("a") as f:
                f.write(json.dumps(step, sort_keys=True) + "\n")

        outbound.append_step = collect
        outbound._notices_disabled = False
        outbound.run(cfg, bot, allowlist, CountingStop(allow=2))
        return

    raise SystemExit(f"unknown scenario mode: {mode}")


if __name__ == "__main__":
    try:
        spec = json.loads(pathlib.Path(sys.argv[1]).read_text())
        main(spec)
    except SystemExit as e:
        print(f"py_driver error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
