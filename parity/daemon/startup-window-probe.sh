#!/usr/bin/env bash
# Upstream start-up window probe (PARITY.md "Start-up window"). Usage: startup-window-probe.sh submap|nosleep|sleep [trials]
# append a step right after `thinkers start` returns / sub_map exists; is it delivered?
set -uo pipefail
REPO="${PARITY_UPSTREAM_ROOT:?set PARITY_UPSTREAM_ROOT to an upstream headlong checkout}"; PATH="$REPO/bin:$PATH"
TRAJ_ID="cafe0000-0000-0000-0000-000000000002"
mode="$1"; lost=0; got=0
for t in $(seq 1 ${2:-8}); do
  TMP=$(mktemp -d)
  env_run() { IDENTITY_DIR="$TMP/id" IDENTITY_NAME=testid TRAJ_DIR="$TMP/id/trajectories" TRAJ_ID="$TRAJ_ID" THINKERS_DIR="$TMP/id/thinkers" MEM_DIR="$TMP/id/memories" "$@"; }
  mkdir -p "$TMP/id/thinkers/napper" "$TMP/id/trajectories/$TRAJ_ID" "$TMP/id/memories"
  printf 'name=testid\ncreated=test\nroot_trajectory=%s\n' "$TRAJ_ID" > "$TMP/id/info.txt"
  : > "$TMP/id/trajectories/$TRAJ_ID/trajectory.jsonl"
  printf '#!/usr/bin/env bash\ncat >> "$IDENTITY_DIR/record"\n' > "$TMP/id/thinkers/napper/step"; chmod +x "$TMP/id/thinkers/napper/step"
  printf '{"types":["action"],"trigger_self":false}\n' > "$TMP/id/thinkers/napper/subscriptions.jsonl"
  if [[ "$mode" == submap ]]; then (env_run thinkers start >/dev/null 2>&1 &); until [[ -s "$TMP/id/run/sub_map" ]]; do :; done; else env_run thinkers start >/dev/null 2>&1; fi
  [[ "$mode" == sleep ]] && sleep 2
  printf '{"type":"action","content":"probe %s","source":"test","step_id":"p%s","ts":"%s"}\n' "$t" "$t" "$(date -u +%FT%TZ)" >> "$TMP/id/trajectories/$TRAJ_ID/trajectory.jsonl"
  for i in $(seq 1 40); do [[ -s "$TMP/id/record" ]] && break; sleep 0.25; done
  if [[ -s "$TMP/id/record" ]]; then got=$((got+1)); else lost=$((lost+1)); fi
  if [[ "$mode" == submap ]]; then printf '{"type":"action","content":"late %s","source":"test","step_id":"l%s","ts":"%s"}\n' "$t" "$t" "$(date -u +%FT%TZ)" >> "$TMP/id/trajectories/$TRAJ_ID/trajectory.jsonl"; for i in $(seq 1 40); do grep -q late "$TMP/id/record" 2>/dev/null && break; sleep 0.25; done; grep -q late "$TMP/id/record" 2>/dev/null && echo "trial $t: later probe delivered; first probe in record: $(grep -c "probe $t" "$TMP/id/record")"; fi
  env_run thinkers stop >/dev/null 2>&1; rm -rf "$TMP"
done
echo "upstream mode=$mode delivered=$got lost=$lost"
