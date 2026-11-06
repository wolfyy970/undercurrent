# Fixture change for release: place name (historical)

> **Historical.**

## Fixture change for release: place name in the golden traces (2026-10-29)

The city named in the captured traces (`golden/trace-01`, `-02`, `-04`, `golden/trace-05-retrieval`) and in the data
derived from them (`parity/retrieval/results.json`, `parity/ui/golden/*.json` and `mindlog.json.gz`, `test/fixtures/rollups/t1`,
`test/topology.test.ts`, `scripts/real-reactive.ts`) was replaced with "Springfield" before publication. One memory
file name changed with it, and `golden/trace-05-retrieval/index.tsv` was rebuilt with upstream's own
`thinkers/retrieval/build-index.sh` over the renamed memories (same 462 rows, re-sorted). Nothing else in the traces
changed; every test that reads them passes unchanged.

