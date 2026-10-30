#!/usr/bin/env bash
# run-matrix.sh <label> [parallel]  — the 13-run matrix of doc 04 (same modes and seeds), P runs at a time.
set -u
LABEL=${1:?label}; P=${2:-4}
HERE=$(cd "$(dirname "$0")" && pwd)
jobs=(
 "none 2" "graceful 11" "graceful 12" "graceful 13" "graceful 14"
 "kill 21" "kill 22" "kill 23"
 "graceful 31 --chaos 10,18" "graceful 32 --chaos 10,18" "graceful 33 --chaos 10,18"
 "kill 41 --chaos 10,18" "kill 42 --chaos 10,18" )
i=0
for j in "${jobs[@]}"; do
  port=$((18800 + i)); i=$((i+1))
  echo "$j --label $LABEL --port $port"
done | xargs -P "$P" -I{} sh -c "node $HERE/run-lostwake.mjs {}" 
