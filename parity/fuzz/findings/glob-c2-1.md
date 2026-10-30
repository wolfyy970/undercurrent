# glob fuzz triage — campaign #2, root cause 1

- classification: **harness-artifact**
- confidence: medium-high
- instances: 2 (`parity/fuzz/findings/glob-1.md`, `glob-2.md`; seed base 2,
  tool sub-seed 1972191973,
  `node parity/fuzz/run-fuzz.mjs --tool glob --seed 2 --count 400`)

## Reproduce

argv `[".hidden","../..","--limit","0"]` (finding #1) and
`["[^a].ts","../.."]` (finding #2) — both flagged by the shrinker as
non-reliably reproducing on re-run ("mints fresh per-invocation randomness");
consistent with a timing race, not a deterministic divergence.

## Upstream vs port

Both captured bash-side stderr as:
```
find: ./headlong-selfupdate-hDxBDZ: No such file or directory
```
and
```
find: ./killall-tree-TYL6IF: No such file or directory
```
respectively — status and `state` (post-run sandbox content hash) match on
both sides; only stderr differs (bash non-empty, port empty).

## Root cause

Per `parity/fuzz/README.md`'s glob safety note, the tool's cwd is nested one
level under a private scratch root (`root/work/`) specifically so a
`..`-shaped hostile DIR argument can escape only that one level, staying
inside `root`. But `DIR=../..` (the fuzzer's max `..` depth, by design) goes
*two* levels up from `root/work`, landing directly in `os.tmpdir()` itself —
`lib/sandbox.mjs`'s `mkSimpleSandbox` (`fuzz-sb-*`) and `mkFullSandbox`
(`fuzz-id-*`) both `mkdtempSync(path.join(os.tmpdir(), ...))`, i.e. every
sandbox across every tool and every concurrent process on this machine is a
sibling directly under the OS temp dir.

`headlong-selfupdate-*` and `killall-tree-*` are not names this fuzz
harness's `sandbox.mjs` mints (it only uses `fuzz-sb-`/`fuzz-id-`/`fuzz-bin-`
prefixes) — they are temp directories created by *other, unrelated live
processes* on this shared multi-agent host (this session alone lists dozens
of concurrently active agent sessions per the environment). Bash's
`collect_files()` (`tools/glob:127`) runs `find . -type f -print` rooted at
that shared tmpdir; between `find`'s directory-tree walk starting and its
`stat`/`readdir` reaching that entry, the unrelated process finished and
cleaned up its own temp dir — a classic TOCTOU race, visible only because
`find` (unlike a single `readdir` snapshot) can outlive the directory it's
walking. The port's directory walk apparently doesn't hit the same interior
node during its (much faster, single-pass) traversal, or tolerates a
disappeared entry silently — either way, `state` (final content hash) is
identical on both sides, confirming this is purely a transient stderr
artifact of `find` racing unrelated processes, not a real behavioral
difference in glob's own file collection.

This is a harness scope issue: `../..` intentionally escapes the sandbox
(that's the point of the hostile-path test), but the harness's shared
`os.tmpdir()` base for every sandbox on a heavily-loaded shared dev machine
means that escape lands somewhere with real, uncontrolled churn from other
processes. It is not a port bug, not a Bash artifact in the sense of
GNU/BSD divergence, and not a new PARITY.md-worthy deviation — it is a
consequence of the harness's sandbox placement colliding with `..`-depth-2
fuzzing on a multi-tenant host.

## Recommendation

No harness code change proposed here (out of this lane's authority without a
demonstrable harness *bug*, and this is closer to "known limitation of a
shared-tmpdir sandbox on a busy host" than a bug in the harness's logic).
If this keeps recurring, a future harness change could root each sandbox
under a per-run private base directory (`mkdtempSync` once per `run-fuzz.mjs`
invocation, then every tool's sandboxes nest under that) so a depth-2 `..`
escape stays inside harness-owned territory instead of the shared OS
tmpdir — flagging as a candidate, not applying it.
