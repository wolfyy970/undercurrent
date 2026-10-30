#!/usr/bin/env python3
"""py_driver.py — drives the real Python bridge's Inbound/outbound.run
against the fake server for one parity scenario. See run-parity.mjs's header
for the full harness design.

Usage: python3 py_driver.py <spec.json>
(run via `uv run --project <clone>/slack python3 py_driver.py <spec.json>` so
`headlong_slack` and its deps resolve from that project's venv — never
modifies the oracle checkout.)

Reads the scenario spec, does the work, exits 0/1. On-disk state and the fake
server's recorded requests are read directly by run-parity.mjs (same
machine, same files) — this driver reports nothing but exit status.

The Slack Web API host is hardcoded (slack.com) in slack_sdk, but
`slack_sdk.web.client.WebClient` accepts a `base_url` constructor argument —
verified by reading the installed slack_sdk source (see run-parity.mjs's
header for the exact wire-format findings that came out of that reading), so
this driver points a real `WebClient` straight at the fake server. No relay
is needed (unlike the telegram harness's MockTransport relay, which was
needed because `headlong_telegram.api.Bot` hardcodes the host with no
override seam at all).

`headlong_slack.inbound.Inbound` takes an `app` object and only ever touches
`app.client` and `app.event(name)` (to register handlers Bolt would
dispatch to — irrelevant here, since this driver calls `_on_event` directly,
the same boundary upstream's own tests/test_outbound.py already drives via
`outbound.run(cfg, bot, allowlist, stop_event)`-shaped calls). A minimal
`FakeApp` duck-types that surface without pulling in `slack_bolt.App` (which
would need a valid-looking token format and does its own setup work this
driver doesn't need).
"""

import json
import logging
import pathlib
import sys
import threading
import time
import traceback

from slack_sdk.web.client import WebClient

from headlong_slack.config import Config
from headlong_slack.inbound import Inbound
from headlong_slack.state import ActiveThreads
from headlong_slack import outbound


class FakeApp:
    """Duck-types the slice of `slack_bolt.App` that `Inbound.__init__` and
    `cli.main` touch: `.client` and `.event(name)` (a decorator-returning
    call, registered but never invoked — this driver calls `_on_event`
    directly instead of routing through Bolt's own dispatch)."""

    def __init__(self, client):
        self.client = client

    def event(self, _name):
        def decorator(fn):
            return fn

        return decorator


def seed_allowlist_style_state(state_dir: pathlib.Path, seed) -> None:
    """No allowlist in the Slack bridge (workspace membership is the only
    gate) — kept as a no-op hook for spec-shape parity with the telegram
    driver's seedAllowlist, unused here."""
    del state_dir, seed


class CountingStop:
    """A `threading.Event`-shaped stop signal, duck-typed: `.is_set()`
    returns False on its first call (let one read/poll pass through), True
    after."""

    def __init__(self):
        self.n = 0

    def is_set(self) -> bool:
        stop = self.n > 0
        self.n += 1
        return stop


def sandbox_path(spec: dict) -> pathlib.Path:
    return pathlib.Path(spec["sandbox"])


def make_cfg(spec: dict) -> Config:
    sandbox = pathlib.Path(spec["sandbox"])
    identity_dir = sandbox / ".identities" / spec["cfg"]["identity"]
    state_dir = sandbox / "state"
    identity_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    return Config(
        serve_root=sandbox,
        identity=spec["cfg"]["identity"],
        identity_dir=identity_dir,
        bot_token=spec["cfg"]["botToken"],
        app_token=spec["cfg"]["appToken"],
        web_url=f"http://127.0.0.1:{spec['port']}",
        state_dir=state_dir,
        thread_followups=spec["cfg"].get("threadFollowups", False),
        thread_join_backfill=spec["cfg"].get("threadJoinBackfill", 0),
        peer_bot_users=frozenset(spec["cfg"].get("peerBotUsers", [])),
        peer_max_turns=spec["cfg"].get("peerMaxTurns", 4),
        peer_hourly_cap=spec["cfg"].get("peerHourlyCap", 30),
    )


def main(spec: dict) -> None:
    cfg = make_cfg(spec)
    base_url = f"http://127.0.0.1:{spec['port']}/api/"
    client = WebClient(token=cfg.bot_token, base_url=base_url)
    app = FakeApp(client)

    mode = spec["mode"]
    if mode == "on_event":
        threads = ActiveThreads(cfg.state_dir / "active_threads.json")
        ib = Inbound(cfg, app, spec["cfg"]["botUserId"], threads)
        log = logging.getLogger("py_driver")
        for event in spec["events"]:
            # Bolt registers reaction_added on a separate handler
            # (`_on_reaction`) from message/app_mention (`_on_event`); the
            # TS port's single onEvent() branches internally instead (see
            # inbound.ts), but the real dispatch boundary here must match
            # Python's, or a reaction event silently no-ops through
            # `_on_event`'s message-shaped gate.
            if event.get("type") == "reaction_added":
                ib._on_reaction(event, log)
            else:
                ib._on_event(event, log)
        # Wait for the drain worker to actually dequeue everything before
        # calling stop(): stop() shuts the shared lookup-pool executor down
        # immediately (`shutdown(wait=False, cancel_futures=True)`), and
        # `_on_event`/`_on_reaction` return the instant they've enqueued —
        # calling stop() right after that for-loop races the worker thread
        # and, for any event whose `_deliver()` needs the lookup pool
        # (reactions.get / conversations.replies), reliably loses: the pool
        # is shut down before the worker even gets scheduled, raising
        # "cannot schedule new futures after shutdown". Production code
        # never hits this — stop() there only runs at real process
        # shutdown, long after events stop arriving.
        deadline = time.time() + 10
        while not ib.queue.empty() and time.time() < deadline:
            time.sleep(0.02)
        time.sleep(0.3)  # let the last dequeued item's _deliver() finish
        ib.stop()
        ib._worker.join(timeout=30)
        return

    if mode == "outbound":
        traj_dir = cfg.identity_dir / "trajectories" / "12345678-root"
        traj_dir.mkdir(parents=True, exist_ok=True)
        traj_file = traj_dir / "trajectory.jsonl"
        # Compact separators (no spaces): match JS `JSON.stringify`'s default
        # byte-for-byte, so both drivers seed an identical trajectory file
        # and the `cursor` byte-offset comparison is meaningful.
        lines = [json.dumps(s, separators=(",", ":")) for s in spec["seedTrajectorySteps"]]
        traj_file.write_text("\n".join(lines) + "\n")
        (cfg.identity_dir / "info.txt").write_text(
            f"name={spec['cfg']['identity']}\n"
            "root_trajectory=12345678-1111-2222-3333-444455556666\n"
        )
        if spec.get("seedCursorOffsetZero"):
            (cfg.state_dir / "cursor").write_text("0")
        if spec.get("seedCursorRaw") is not None:
            (cfg.state_dir / "cursor").write_text(spec["seedCursorRaw"].replace("<SANDBOX>", str(sandbox_path(spec))))
        # 2e39a3f: delivery notices go through outbound.append_step (production:
        # bin/traj). Both drivers swap it for a sink file so the notice the
        # bridge BUILT is what gets compared (upstream's own conftest does the
        # same). Appending is by one JSON object per line.
        notices_file = sandbox_path(spec) / "notices.jsonl"

        def collect(serve_root, traj_path, step):
            with notices_file.open("a") as f:
                f.write(json.dumps(step, sort_keys=True) + "\n")

        outbound.append_step = collect
        outbound._notices_disabled = False
        threads = ActiveThreads(cfg.state_dir / "active_threads.json")
        outbound.run(cfg, client, threads, CountingStop())
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
