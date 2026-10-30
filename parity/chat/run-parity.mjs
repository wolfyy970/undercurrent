#!/usr/bin/env node
// run-parity.mjs — ADVERSARIAL DIFFERENTIAL parity proof for the `chat` subsystem.
//
// Runs the REAL Bash tool (headlong/bin/chat) and the TS port
// (headlong-ts/bin/chat.mjs) on identical inputs in isolated scratch sandboxes,
// then diffs stdout + stderr + exit code + on-disk trajectory bytes. One scenario
// per subcommand / flag / quirk / error path, harvested adversarially from the
// Bash source — including paths a friendly harness would skip.
//
// External deps the REAL chat shells out to, made deterministic:
//   - `traj` (real Bash): headlong/bin on PATH; same <hex8>-root/trajectory.jsonl.
//   - `jq`: on PATH (/usr/bin/jq).
//   - `timeout`: real chat wraps reply_to inference + answered-guard in
//     `timeout 10 …`; macOS ships none, so we STUB a coreutils passthrough on
//     PATH — otherwise `|| reply_to=""` silently disables inference (an ENV
//     artifact, not the tool's Linux/Docker contract). The port infers
//     unconditionally, matching that intended path.
//
// STATE COMPARISON — TWO ways, because escaping matters:
//   * stateRaw: the trajectory file BYTES, with only nondeterminism normalized
//     (UUID step_id/reply_to -> <ID>, ISO ts -> <TS>). This is the STRICT test
//     and the pass criterion — it catches jq-vs-JSON.stringify escaping drift.
//   * stateSem: each line round-tripped through JSON.parse/JSON.stringify (what
//     a semantic-only harness compares). Recorded so escaping-only divergences
//     (stateRaw DIFFER but stateSem MATCH) are distinguishable from real content
//     divergences (both DIFFER).
//
// Repeatable: `PARITY_BASH_CHAT=/abs/headlong/bin/chat node run-parity.mjs`.
// Writes results.json + report.md beside this file. Exit 0 iff every scenario
// reaches PARITY on stdout+stderr+status+stateRaw.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// When this file lives at parity/chat/run-parity.mjs, the repo root is two up.
const REPO = process.env.PARITY_TS_REPO || path.resolve(HERE, "../..");
// Path to the real Bash tool. Scrubbed to a placeholder for release; set
// PARITY_BASH_CHAT=/abs/path/to/headlong/bin/chat to reproduce the run, or
// PARITY_UPSTREAM_ROOT=/abs/path/to/headlong (a full checkout) as a fallback.
const BASH_CHAT =
  process.env.PARITY_BASH_CHAT ||
  (process.env.PARITY_UPSTREAM_ROOT ? path.join(process.env.PARITY_UPSTREAM_ROOT, "bin/chat") : "<HEADLONG_ROOT>/bin/chat");
const BASH_BIN_DIR = path.dirname(BASH_CHAT); // real `traj` lives beside `chat`
const TS_CHAT = path.join(REPO, "bin", "chat.mjs");

// --- artifact scrubbing --------------------------------------------------------
// No absolute local paths in committed report.md/results.json beyond the <CHAT>
// marker scrubPaths() already substitutes into stderr for comparison: any
// occurrence of the real upstream root (derived from PARITY_BASH_CHAT at
// runtime) or of $HOME is replaced with a placeholder BEFORE writing, so
// re-running never reintroduces them. Applied only to display/report values,
// after every `cmp` has already been computed — it cannot affect PASS/FAIL.
const HEADLONG_ROOT = path.resolve(path.dirname(BASH_CHAT), "..");
const HOME = os.homedir();
function scrubArtifactPaths(s) {
  if (typeof s !== "string") return s;
  let out = s;
  if (HEADLONG_ROOT) out = out.split(HEADLONG_ROOT).join("<HEADLONG_ROOT>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

// --- fake `timeout` on PATH (coreutils passthrough) ---------------------------
const FAKEBIN = fs.mkdtempSync(path.join(os.tmpdir(), "chat-parity-bin-"));
fs.writeFileSync(
  path.join(FAKEBIN, "timeout"),
  `#!/usr/bin/env bash
# Deterministic stub for coreutils \`timeout\`: drop DURATION, exec the rest.
shift
exec "$@"
`
);
fs.chmodSync(path.join(FAKEBIN, "timeout"), 0o755);

// --- normalization ------------------------------------------------------------
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
// `chat pending --json`'s age_s is `floor(now - ts)` computed independently
// by the bash and TS subprocesses a few ms apart — a fixture aged just past
// a whole-second boundary can report N in one process and N+1 in the other.
// Not a port bug: normalized out like every other real-clock/random value
// above (UUID, ISO ts).
const AGE_S_RE = /"age_s":\d+/g;
// The inode numbers in "trajectory file replaced (inode A -> B)" differ per sandbox; so does the
// third field of the `.offset` record.
const INODE_RE = /inode \S+ -> \d+/g;
function normalize(s) {
  if (s == null) return s;
  return s
    .replace(ISO_RE, "<TS>")
    .replace(UUID_RE, "<ID>")
    .replace(AGE_S_RE, '"age_s":<AGE>')
    .replace(INODE_RE, "inode <A> -> <B>")
    .replace(/(?:\/private)?\/\S*?chat-parity-sb-[A-Za-z0-9]+/g, "<SB>");
}
// Absolute paths of the real bash script leak into ${2:?} / exec errors; scrub
// them so the ONLY residual stderr difference is genuine wording, not a path.
function scrubPaths(s) {
  if (s == null) return s;
  return s.split(BASH_CHAT).join("<CHAT>");
}

// --- on-disk trajectory serialization ----------------------------------------
function readRoot(rootFileAbs) {
  try {
    return fs.readFileSync(rootFileAbs, "utf8");
  } catch {
    return null;
  }
}
function stateRawOf(rootFileAbs) {
  const raw = readRoot(rootFileAbs);
  if (raw == null) return "<no trajectory>";
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return "<empty trajectory>";
  return normalize(lines.join("\n"));
}
function stateSemOf(rootFileAbs) {
  const raw = readRoot(rootFileAbs);
  if (raw == null) return "<no trajectory>";
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "<empty trajectory>";
  return normalize(
    lines
      .map((l) => {
        try {
          return JSON.stringify(JSON.parse(l));
        } catch {
          return l;
        }
      })
      .join("\n")
  );
}

// Derived-index state next to the root trajectory (sync 2e39a3f lane e): the three index files, the
// `.offset` cursor record (inode field normalized), and which lock/steal dirs or temp files remain.
// Compared only for scenarios that set `checkIndex`.
function idxStateOf(rootFileAbs) {
  const dir = path.dirname(rootFileAbs);
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return "<no dir>";
  }
  for (const n of names) {
    if (n === "trajectory.jsonl") continue;
    const p = path.join(dir, n);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) out.push(`${n}: <symlink>`);
    else if (st.isDirectory()) out.push(`${n}/: ${fs.readdirSync(p).sort().join(",") || "<empty>"}`);
    else {
      let t = fs.readFileSync(p, "utf8");
      if (n === "messages.jsonl.offset") t = t.replace(/^(\S+ \S+ )\S+/, "$1<INO>");
      out.push(`${n}: ${t}`);
    }
  }
  return normalize(out.join("\n"));
}

function rootFileOf(sbAbs, trajId) {
  return path.join(sbAbs, "traj", `${trajId.slice(0, 8)}-root`, "trajectory.jsonl");
}

// --- seeds --------------------------------------------------------------------
const TID = "12345678-1111-2222-3333-444455556666";
const IN1 = "aaaa0000-0000-0000-0000-000000000001";
const IN2 = "aaaa0000-0000-0000-0000-000000000002";
const HEAD = `{"type":"trajectory","step_id":"${TID}","ts":"2026-01-01T00:00:00.000Z"}`;
// Upstream sync 1b person/thread key fixture names (design/conversation_memory.md).
const ANDY_T1 = "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149";
const ANDY_T2 = "slack-U0614H65RN3-C0BMVH6LM4K-1787419141.482799";
const ANDY_DM = "slack-U0614H65RN3-D0BNW58GP5W";
const BRADEN = "slack-U095QV3JKA6-C0BMVH6LM4K-1787508187.726149";
// `chat pending` (2fed66c) fixtures. Relative-to-now, same technique
// threadConvo below uses for --since: the age lands mid-bucket (5m), so a
// few-ms skew between the bash and TS subprocess invocations cannot flip
// which age_text bucket the TEXT-mode assertion falls into.
const agoTs = (s) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
const TRIGGER1 = "cccc1111-0000-0000-0000-000000000001";
const REACT_MSG_ID = "aaaa0000-0000-0000-0000-00000000aaaa";
const SEEDS = {
  head: [HEAD],
  inbound: [
    HEAD,
    `{"type":"message","content":"you there?","from":"bob","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
  ],
  answered: [
    HEAD,
    `{"type":"message","content":"you there?","from":"bob","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
    `{"type":"message","content":"yes","from":"alice","to":"bob","source":"chat","reply_to":"${IN1}","step_id":"bbbb0000-0000-0000-0000-000000000009","ts":"2026-01-01T00:02:00.000Z"}`,
  ],
  multiInbound: [
    HEAD,
    `{"type":"message","content":"ping 1","from":"bob","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
    `{"type":"message","content":"ping 2","from":"bob","to":"alice","source":"chat","step_id":"${IN2}","ts":"2026-01-01T00:02:00.000Z"}`,
  ],
  history: [
    HEAD,
    `{"type":"human-msg","content":"hi from human","from":"jo","step_id":"cccc0000-0000-0000-0000-000000000003","ts":"2026-01-01T00:01:00.000Z"}`,
    `{"type":"agent-msg","content":"hi from agent","step_id":"dddd0000-0000-0000-0000-000000000004","ts":"2026-01-01T00:02:00.000Z"}`,
    `{"type":"message","content":"hi from bob","from":"bob","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:03:00.000Z"}`,
  ],
  fallbacks: [
    HEAD,
    `{"type":"message","content":"no from field","to":"alice","source":"chat","step_id":"${IN1}","ts":"2026-01-01T00:01:00.000Z"}`,
    `{"type":"message","content":"no to field","from":"bob","source":"chat","step_id":"${IN2}","ts":"2026-01-01T00:02:00.000Z"}`,
    `{"type":"human-msg","content":"human no from","step_id":"cccc0000-0000-0000-0000-000000000005","ts":"2026-01-01T00:03:00.000Z"}`,
  ],
  // Upstream sync 1b (design/conversation_memory.md, parts 1+2): a
  // multi-thread/DM conversation, timestamps relative to "now" (not the
  // fixed 2026-01-01 the other seeds use) so `--since 7d` has a real boundary
  // to cross — mirrors tests/test_chat_history_index.sh's own fixture.
  threadConvo: (() => {
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
    return [
      HEAD,
      `{"step_id":"a1","type":"message","from":"${ANDY_T1}","to":"alice","content":"how is the bridge work going","ts":"${ago(8 * 86400)}","source":"chat"}`,
      `{"step_id":"a2","type":"message","from":"alice","to":"${ANDY_T1}","content":"half done","ts":"${ago(8 * 86400 - 60)}","source":"chat"}`,
      `{"step_id":"a3","type":"message","from":"${ANDY_T2}","to":"alice","content":"that svg is not rendering","ts":"${ago(7200)}","source":"chat"}`,
      `{"step_id":"a4","type":"message","from":"alice","to":"${ANDY_T2}","content":"slack ate it","ts":"${ago(7100)}","source":"chat"}`,
      `{"step_id":"b1","type":"message","from":"${BRADEN}","to":"alice","content":"middle name of washington?","ts":"${ago(3600)}","source":"chat"}`,
      `{"step_id":"b2","type":"message","from":"alice","to":"${BRADEN}","content":"he had none","ts":"${ago(3500)}","source":"chat"}`,
      `{"step_id":"a5","type":"message","from":"${ANDY_DM}","to":"alice","content":"sure!","ts":"${ago(60)}","source":"chat"}`,
    ];
  })(),
  // `chat pending` (2fed66c): a responder deferral (DEFER) 5 minutes old, no
  // observation has resolved it yet.
  pendingUnresolved: [
    HEAD,
    `{"type":"message","content":"can you check the deploy?","from":"bob","to":"alice","source":"chat","step_id":"${TRIGGER1}","ts":"${agoTs(305)}"}`,
    `{"type":"action","source":"responder","trigger_step":"${TRIGGER1}","person":"bob","request":"check the deploy","step_id":"dddd1111-0000-0000-0000-000000000001","ts":"${agoTs(300)}"}`,
  ],
  // Same deferral, now closed by an observation carrying resolves=<trigger>.
  pendingResolved: [
    HEAD,
    `{"type":"message","content":"can you check the deploy?","from":"bob","to":"alice","source":"chat","step_id":"${TRIGGER1}","ts":"${agoTs(305)}"}`,
    `{"type":"action","source":"responder","trigger_step":"${TRIGGER1}","person":"bob","request":"check the deploy","step_id":"dddd1111-0000-0000-0000-000000000001","ts":"${agoTs(300)}"}`,
    `{"type":"observation","resolves":"${TRIGGER1}","content":"deploy is green","step_id":"eeee1111-0000-0000-0000-000000000001","ts":"${agoTs(60)}"}`,
  ],
  // `chat react`'s source_url auto-populate (6a98ab5): the message it reacts
  // to already carries source_url; --reply-to alone should find it.
  reactSourceUrl: [
    HEAD,
    `{"type":"message","content":"look at this","from":"bob","to":"alice","source":"chat","source_url":"https://slack.example/archives/C1/p123","step_id":"${REACT_MSG_ID}","ts":"2026-01-01T00:01:00.000Z"}`,
  ],
};

// stdin payloads with raw control bytes (Buffer, written to a file, piped in).
const DEL_STDIN = Buffer.from([0x41, 0x7f, 0x42, 0x0a]); // "A" DEL "B" \n
const NUL_STDIN = Buffer.from([0x41, 0x00, 0x42, 0x0a]); // "A" NUL "B" \n

function makeSandbox(sc) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "chat-parity-sb-"));
  if (sc.chatrc != null) fs.writeFileSync(path.join(sb, ".chatrc"), sc.chatrc);
  const steps = SEEDS[sc.seed ?? "head"];
  const rf = rootFileOf(sb, TID);
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, steps.join("\n") + "\n");
  if (sc.files) {
    for (const f of sc.files) {
      const abs = path.join(sb, f.name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
  }
  if (sc.setup) sc.setup(sb, rf);
  return sb;
}

function runTool(kind, sc, sb) {
  const env = { ...process.env };
  delete env.TRAJ_DIR;
  delete env.TRAJ_ID;
  delete env.ROOT_TRAJ_ID;
  delete env.IDENTITY_NAME;
  delete env.CHATRC;
  delete env.SHELLM_RUN_STEP_ID;
  env.LC_ALL = "C";
  env.PATH = `${FAKEBIN}:${BASH_BIN_DIR}:${env.PATH}`;
  if (!sc.noEnv) {
    env.TRAJ_DIR = path.join(sb, "traj");
    env.TRAJ_ID = sc.trajIdUnset ? "" : TID;
    if (!sc.identityUnset) env.IDENTITY_NAME = sc.identity ?? "alice";
    else env.IDENTITY_NAME = "";
  }
  Object.assign(env, sc.env || {});

  const argv = kind === "bash" ? sc.argv : [TS_CHAT, ...sc.argv];
  const cmd = kind === "bash" ? BASH_CHAT : "node";
  const input = sc.stdinBuf != null ? sc.stdinBuf : sc.stdin != null ? sc.stdin : "";

  const res = spawnSync(cmd, argv, {
    cwd: sb,
    env,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  const rf = rootFileOf(sb, TID);
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
    signal: res.signal,
    stateRaw: stateRawOf(rf),
    stateSem: stateSemOf(rf),
    idxState: idxStateOf(rf),
  };
}

// --- scenarios ----------------------------------------------------------------
const RC = "default_send_from=alice\n";
const scenarios = [
  // ---- dispatch / env gate ----
  { group: "global", name: "help-short", argv: ["-h"], noEnv: true },
  { group: "global", name: "help-long", argv: ["--help"], noEnv: true },
  { group: "global", name: "help-word", argv: ["help"], noEnv: true },
  { group: "global", name: "no-args-with-env", argv: [], chatrc: RC },
  { group: "global", name: "no-args-without-env-dies", argv: [], noEnv: true,
    note: "quirk: bare chat hits TRAJ_DIR gate before usage" },
  { group: "global", name: "unknown-command-with-env", argv: ["bogus"], chatrc: RC },
  { group: "global", name: "unknown-command-without-env", argv: ["bogus"], noEnv: true,
    note: "quirk: env gate precedes the unknown-command die" },
  { group: "global", name: "traj-id-unset-dies", argv: ["history"], trajIdUnset: true,
    note: "TRAJ_DIR set, TRAJ_ID empty -> second gate fires" },

  // ---- send ----
  { group: "send", name: "send-basic", argv: ["send", "--to", "bob", "hello world"], chatrc: RC },
  { group: "send", name: "send-multiword", argv: ["send", "--to", "bob", "buy", "milk", "today"], chatrc: RC },
  { group: "send", name: "send-flags-interleaved", argv: ["send", "hello", "--to", "bob", "world"], chatrc: RC },
  { group: "send", name: "send-from-explicit", argv: ["send", "--from", "carol", "--to", "bob", "hi"] },
  { group: "send", name: "send-flag-value-looks-like-flag", argv: ["send", "--from", "--to", "bob", "hi"],
    note: "adversarial: --from consumes --to as its literal value" },
  { group: "send", name: "send-self-refuses", argv: ["send", "--from", "alice", "--to", "alice", "loop"] },
  { group: "send", name: "send-stdin", argv: ["send", "--to", "bob"], stdin: "from stdin\nline2\n", chatrc: RC },
  { group: "send", name: "send-stdin-trailing-newlines", argv: ["send", "--to", "bob"], stdin: "trail\n\n\n", chatrc: RC,
    note: "adversarial: $(cat) strips ALL trailing newlines" },
  { group: "send", name: "send-stdin-whitespace-kept", argv: ["send", "--to", "bob"], stdin: "  \n", chatrc: RC,
    note: "adversarial: leading spaces kept, only trailing newline stripped -> sends '  '" },
  { group: "send", name: "send-empty-stdin-dies", argv: ["send", "--to", "bob"], stdin: "", chatrc: RC },
  { group: "send", name: "send-no-default-from-dies", argv: ["send", "--to", "bob", "hi"], seed: "head",
    note: "no --from, no .chatrc -> die on from" },
  { group: "send", name: "send-no-to-dies", argv: ["send", "--from", "carol", "hi"], identityUnset: true,
    note: "adversarial: --from set, IDENTITY_NAME unset, no --to -> die on to" },
  { group: "send", name: "send-from-missing-value", argv: ["send", "--to", "bob", "--from"], chatrc: RC,
    note: "DOC-DEVIATION: bash ${2:?} text vs port clean msg" },
  { group: "send", name: "send-to-empty-value", argv: ["send", "--to", "", "hi"], chatrc: RC,
    note: "adversarial DOC-DEVIATION: --to '' -> ${2:?} dies (empty triggers colon form)" },
  { group: "send", name: "send-multibyte", argv: ["send", "--to", "bob", "café ÜBER — 日本語 🚀"], chatrc: RC,
    note: "jq -Rsa ascii-escape normalized back to literal UTF-8 by jq -c" },
  { group: "send", name: "send-del-char-stdin", argv: ["send", "--to", "bob"], stdinBuf: DEL_STDIN, chatrc: RC,
    note: "adversarial ESCAPING: DEL 0x7f -> jq \\u007f vs JSON.stringify literal byte" },
  { group: "send", name: "send-nul-char-stdin", argv: ["send", "--to", "bob"], stdinBuf: NUL_STDIN, chatrc: RC,
    note: "adversarial NUL: bash $(cat) drops 0x00, port keeps it" },
  { group: "send", name: "send-with-source-url", argv: ["send", "--to", "bob", "--source-url", "https://slack.example/archives/C1/p123", "hello"], chatrc: RC,
    note: "1c: f68c1d8 — source_url appended when non-empty, after source" },
  { group: "send", name: "send-source-url-empty-value-dies", argv: ["send", "--to", "bob", "--source-url", "", "hello"], chatrc: RC,
    note: "adversarial DOC-DEVIATION: --source-url '' -> ${2:?} dies (same class as --to '')" },

  // ---- send-file ----
  { group: "send-file", name: "send-file-basic", argv: ["send-file", "--to", "bob", "note.txt"],
    files: [{ name: "note.txt", content: "file line1\nfile line2\n" }], chatrc: RC },
  { group: "send-file", name: "send-file-strip-trailing-nl", argv: ["send-file", "--to", "bob", "n.txt"],
    files: [{ name: "n.txt", content: "body\n\n\n" }], chatrc: RC,
    note: "adversarial: $(cat file) strips trailing newlines" },
  { group: "send-file", name: "send-file-subdir-basename", argv: ["send-file", "--to", "bob", "sub/deep.txt"],
    files: [{ name: "sub/deep.txt", content: "deep\n" }], chatrc: RC,
    note: "adversarial: filename = basename of the arg path" },
  { group: "send-file", name: "send-file-missing", argv: ["send-file", "--to", "bob", "nope.txt"], chatrc: RC },
  { group: "send-file", name: "send-file-missing-before-fromto", argv: ["send-file", "nope.txt"], seed: "head", identityUnset: true,
    note: "adversarial: File-not-found checked BEFORE from/to resolution" },
  { group: "send-file", name: "send-file-no-arg", argv: ["send-file", "--to", "bob"], chatrc: RC },
  { group: "send-file", name: "send-file-self-no-guard", argv: ["send-file", "--from", "alice", "--to", "alice", "self.txt"],
    files: [{ name: "self.txt", content: "self\n" }],
    note: "adversarial: send-file has NO self-send guard (unlike send/reply)" },

  // ---- send-file content_b64 (1c: e286745, c647609 — the frozen-surface
  // gap callout (d) flagged: content_b64 always present, text keeps readable
  // content, binary gets a `[file: name]` marker) ----
  { group: "send-file", name: "send-file-text-keeps-content-and-b64", argv: ["send-file", "--to", "bob", "note.txt"],
    files: [{ name: "note.txt", content: "hello file body\nsecond line\n" }], chatrc: RC,
    note: "1c: e286745/c647609 — text file: content stays readable, content_b64 also present" },
  { group: "send-file", name: "send-file-binary-nul-marker-and-b64", argv: ["send-file", "--to", "bob", "blob.bin"],
    files: [{ name: "blob.bin", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]) }],
    chatrc: RC, note: "1c: c647609 — a NUL byte makes it binary: content becomes [file: name]" },
  { group: "send-file", name: "send-file-binary-invalid-utf8-marker-and-b64", argv: ["send-file", "--to", "bob", "invalid.bin"],
    files: [{ name: "invalid.bin", content: Buffer.from([0x41, 0x80, 0x42, 0x0a]) }], chatrc: RC,
    note: "1c: c647609 — invalid UTF-8 with NO NUL byte is still binary" },
  { group: "send-file", name: "send-file-empty-dies", argv: ["send-file", "--to", "bob", "empty.txt"],
    files: [{ name: "empty.txt", content: "" }], chatrc: RC,
    note: "1c: f68ae29 — an empty file dies before from/to resolution" },
  { group: "send-file", name: "send-file-too-large-dies", argv: ["send-file", "--to", "bob", "big.txt"],
    files: [{ name: "big.txt", content: "0123456789" }], env: { CHAT_SEND_FILE_MAX_BYTES: "5" }, chatrc: RC,
    note: "1c: f68ae29 — CHAT_SEND_FILE_MAX_BYTES override, file exceeds it" },
  { group: "send-file", name: "send-file-max-bytes-non-integer-dies", argv: ["send-file", "--to", "bob", "note.txt"],
    files: [{ name: "note.txt", content: "hi\n" }], env: { CHAT_SEND_FILE_MAX_BYTES: "abc" }, chatrc: RC,
    note: "1c: f68ae29 — a non-integer CHAT_SEND_FILE_MAX_BYTES dies" },

  // ---- react (1c: 6a98ab5, 1d5670a) ----
  { group: "react", name: "react-basic", argv: ["react", "bob", "thumbsup"], chatrc: RC },
  { group: "react", name: "react-colon-wrapped", argv: ["react", "bob", ":thumbsup:"], chatrc: RC,
    note: "leading/trailing colon stripped once each" },
  { group: "react", name: "react-plus-one", argv: ["react", "bob", "+1"], chatrc: RC },
  { group: "react", name: "react-invalid-emoji-dies", argv: ["react", "bob", "has space"], chatrc: RC,
    note: "1c: 1d5670a — emoji-name class rejects anything but [-a-z0-9_+:]" },
  { group: "react", name: "react-lone-colon-dies", argv: ["react", "bob", ":"], chatrc: RC,
    note: "adversarial: strips to empty, regex requires >=1 char" },
  { group: "react", name: "react-flags-after-to-name", argv: ["react", "bob", "--reply-to", IN1, "thumbsup"], seed: "inbound",
    note: "1c: 6a98ab5 — the two-pass flag loop accepts flags AFTER <to_name> too" },
  { group: "react", name: "react-reply-to-and-explicit-source-url", argv: ["react", "--reply-to", IN1, "--source-url", "https://example.com/x", "bob", "eyes"], seed: "inbound" },
  { group: "react", name: "react-reply-to-autolooks-up-source-url", argv: ["react", "--reply-to", REACT_MSG_ID, "bob", "eyes"], seed: "reactSourceUrl",
    note: "no --source-url given: looked up from the reacted-to step's own source_url field" },
  { group: "react", name: "react-missing-to-dies", argv: ["react"], chatrc: RC },
  { group: "react", name: "react-missing-emoji-dies", argv: ["react", "bob"], chatrc: RC },
  { group: "react", name: "react-extra-args-dies", argv: ["react", "bob", "thumbsup", "extra"], chatrc: RC },
  { group: "react", name: "react-no-from-dies", argv: ["react", "bob", "thumbsup"], identityUnset: true,
    note: "no --from, no chatrc default_send_from -> die" },

  // ---- pending (1c: 2fed66c) ----
  { group: "pending", name: "pending-none-text", argv: ["pending"], seed: "head",
    note: "no deferrals.jsonl yet -> silent success, no output" },
  { group: "pending", name: "pending-none-json", argv: ["pending", "--json"], seed: "head" },
  { group: "pending", name: "pending-unresolved-text", argv: ["pending"], seed: "pendingUnresolved" },
  { group: "pending", name: "pending-unresolved-json", argv: ["pending", "--json"], seed: "pendingUnresolved" },
  { group: "pending", name: "pending-resolved-empty", argv: ["pending"], seed: "pendingResolved",
    note: "an observation carrying resolves=<trigger> closes the deferral" },
  { group: "pending", name: "pending-max-age-excludes", argv: ["pending", "--max-age", "1s"], seed: "pendingUnresolved",
    note: "the fixture is ~5 minutes old -> --max-age 1s drops it" },
  { group: "pending", name: "pending-max-age-invalid-dies", argv: ["pending", "--max-age", "bogus"], seed: "pendingUnresolved",
    note: "1c: 2fed66c — --max-age shares _duration_s's --argjson crash class with history --since (bug #47)" },
  { group: "pending", name: "pending-unknown-arg-dies", argv: ["pending", "--bogus"], seed: "head" },

  // ---- reply ----
  { group: "reply", name: "reply-infers-reply-to", argv: ["reply", "bob", "thanks!"], seed: "inbound" },
  { group: "reply", name: "reply-multiword", argv: ["reply", "bob", "thanks", "a", "lot"], seed: "inbound",
    note: "adversarial: positional message words joined" },
  { group: "reply", name: "reply-multi-unanswered-picks-last", argv: ["reply", "bob", "re"], seed: "multiInbound",
    note: "adversarial: infers the LAST unanswered inbound (IN2)" },
  { group: "reply", name: "reply-already-answered-unstamped", argv: ["reply", "bob", "more"], seed: "answered",
    note: "inbound already answered -> reply_to stays absent" },
  { group: "reply", name: "reply-explicit-dup-skips", argv: ["reply", "--reply-to", IN1, "bob", "dup"], seed: "answered",
    note: "explicit --reply-to already answered -> duplicate guard skips (rc0, no append)" },
  { group: "reply", name: "reply-explicit-fresh", argv: ["reply", "--reply-to", IN1, "bob", "answer"], seed: "inbound",
    note: "explicit --reply-to, not answered -> stamps + sends" },
  { group: "reply", name: "reply-self-refuses", argv: ["reply", "alice", "hi me"], seed: "inbound" },
  { group: "reply", name: "reply-no-name", argv: ["reply"], seed: "inbound" },
  { group: "reply", name: "reply-no-identity-dies", argv: ["reply", "bob", "hi"], seed: "inbound", identityUnset: true,
    note: "adversarial: IDENTITY_NAME unset -> reply dies before inference" },
  { group: "reply", name: "reply-reply-to-missing-value", argv: ["reply", "--reply-to"], seed: "inbound",
    note: "adversarial DOC-DEVIATION: --reply-to missing value ${2:?}" },
  { group: "reply", name: "reply-stdin", argv: ["reply", "bob"], stdin: "reply via stdin\n", seed: "inbound" },

  // ---- history ----
  { group: "history", name: "history-default", argv: ["history"], seed: "history", chatrc: RC },
  { group: "history", name: "history-limit-1", argv: ["history", "1"], seed: "history", chatrc: RC },
  { group: "history", name: "history-empty", argv: ["history"], seed: "head", chatrc: RC },
  { group: "history", name: "history-fallbacks", argv: ["history"], seed: "fallbacks", chatrc: RC,
    note: "adversarial: unknown / ? / you fallbacks for missing from/to" },
  { group: "history", name: "history-empty-string-arg", argv: ["history", ""], seed: "history", chatrc: RC,
    note: "adversarial: empty arg -> default 20 ([[ -n ]] guard)" },
  { group: "history", name: "history-zero", argv: ["history", "0"], seed: "history", chatrc: RC,
    note: "adversarial: tail -n 0 -> empty" },
  { group: "history", name: "history-plus-n", argv: ["history", "+2"], seed: "history", chatrc: RC,
    note: "adversarial: tail -n +2 (from line 2)" },
  { group: "history", name: "history-negative", argv: ["history", "-2"], seed: "history", chatrc: RC,
    note: "adversarial: tail -n -2 (last 2)" },
  { group: "history", name: "history-nonnumeric", argv: ["history", "abc"], seed: "history", chatrc: RC,
    note: "adversarial DEVIATION: tail illegal-offset error vs port clean msg (rc1, stdout empty)" },
  { group: "history", name: "history-float", argv: ["history", "1.5"], seed: "history", chatrc: RC,
    note: "adversarial DEVIATION: same class as nonnumeric" },
  { group: "history", name: "history-huge-overflow", argv: ["history", "999999999999999999999"], seed: "history", chatrc: RC,
    note: "adversarial REAL DIVERGENCE: bash tail errors (rc1, empty) vs port prints all (rc0)" },
  { group: "history", name: "history-huge-overflow-plus", argv: ["history", "+999999999999999999999"], seed: "history", chatrc: RC,
    note: "adversarial: same overflow class via the `+N` (start-at-line) tail form — a shape the plain-number overflow scenario alone doesn't exercise" },

  // ---- history --with / --thread / person-key / thread-key (conversation
  // memory, upstream sync 1b: design/conversation_memory.md parts 1+2) ----
  { group: "convo-memory", name: "person-key-slack-thread", argv: ["person-key", ANDY_T1], seed: "head" },
  { group: "convo-memory", name: "person-key-slack-dm", argv: ["person-key", ANDY_DM], seed: "head" },
  { group: "convo-memory", name: "person-key-telegram", argv: ["person-key", "telegram-8525624593-8525624593"], seed: "head" },
  { group: "convo-memory", name: "person-key-pwa", argv: ["person-key", "pwa-andy"], seed: "head" },
  { group: "convo-memory", name: "person-key-bare-name", argv: ["person-key", "Andy"], seed: "head" },
  { group: "convo-memory", name: "thread-key-slack-thread", argv: ["thread-key", ANDY_T1], seed: "head" },
  { group: "convo-memory", name: "thread-key-slack-dm-empty", argv: ["thread-key", ANDY_DM], seed: "head" },
  { group: "convo-memory", name: "with-groups-threads-and-dm-json", argv: ["history", "--with", ANDY_T1, "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "with-text-output", argv: ["history", "--with", ANDY_T1], seed: "threadConvo" },
  { group: "convo-memory", name: "with-since-7d-drops-old", argv: ["history", "--with", ANDY_DM, "--since", "7d", "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "with-n-caps-and-accepts-person-key", argv: ["history", "--with", "slack:U0614H65RN3", "-n", "2", "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "with-unrelated-name-empty", argv: ["history", "--with", "Braden999nobody", "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "thread-returns-everyone-json", argv: ["history", "--thread", BRADEN, "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "thread-since-bounds-window", argv: ["history", "--thread", BRADEN, "--since", "1d", "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "with-plus-thread-union", argv: ["history", "--with", BRADEN, "--thread", BRADEN, "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "thread-on-dm-empty", argv: ["history", "--thread", ANDY_DM, "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "thread-key-as-thread-arg", argv: ["history", "--thread", "slack-thread:C0BMVH6LM4K-1787508187.726149", "-n", "1", "--json"], seed: "threadConvo" },
  { group: "convo-memory", name: "with-aliases-merge-via-mem-dir", argv: ["history", "--with", "pwa-andy", "--json"], seed: "threadConvo",
    env: { MEM_DIR: "mem" },
    files: [{ name: "mem/2026-01-01-00-00-00_abcd1234_andy.md",
      content: "---\nid: abcd1234\ntype: person\nperson_key: slack:U0614H65RN3\naliases: [pwa:andy, Andy]\nsummary: Andy\n---\n\nAndy prefers short replies.\n" }],
    note: "a type:person MEM_DIR memory's aliases merge pwa-andy into the slack thread/DM history" },
  { group: "convo-memory", name: "history-count-still-validated-with-flags-present", argv: ["history", "-n", "abc"], seed: "threadConvo",
    note: "the new digit-only count validation (84aa37e) applies on every path, including alongside other flags" },
  { group: "convo-memory", name: "reply-follow-up-bypasses-duplicate-guard", argv: ["reply", "--follow-up", "--reply-to", IN1, "bob", "the actual answer"], seed: "answered",
    note: "part 5: --follow-up delivers a second reply to an already-answered trigger, which a plain reply's duplicate guard would refuse" },
  { group: "convo-memory", name: "reply-plain-duplicate-still-refused", argv: ["reply", "--reply-to", IN1, "bob", "dup"], seed: "answered",
    note: "control: without --follow-up the existing duplicate guard still fires (unchanged)" },

  // ---- repl ----
  { group: "repl", name: "repl-no-tui-127", argv: ["repl"], seed: "head",
    note: "adversarial DEVIATION: neither TUI on PATH -> rc127 both, exec-not-found stderr wording differs" },
];

// ---- Upstream sync 2e39a3f, lane (e): send guards, `chat sent`, index lock/trim/rebuild, index-reset ----
const msgRow = (id, from, to, content, secsAgo, extra = {}) =>
  JSON.stringify({ step_id: id, type: "message", from, to, content, ts: agoTs(secsAgo), source: "chat", ...extra });
const dlvRow = (id, trig, status, secsAgo, extra = {}) =>
  JSON.stringify({ step_id: id, type: "delivery", trigger_step: trig, status, transport: "slack", ts: agoTs(secsAgo), ...extra });
const SLACK_U = "slack-U0BFD9NDVE3";
const SLACK_C = "slack-C0BMVH6LM4K";
const LONG = "L".repeat(8100);
SEEDS.sentBase = [
  HEAD,
  msgRow("s1", "alice", "bob", "weekly papers", 7200, { key: "wk1" }),
  msgRow("s2", "alice", SLACK_U, "hello slack", 3600),
  msgRow("s3", "alice", SLACK_C, "channel post", 1800, { key: "chan1" }),
  msgRow("s4", "alice", SLACK_U, "will fail", 900, { key: "fail1" }),
  msgRow("s5", "alice", "bob", "line one\nline two is here and this body keeps going well past eighty characters so it gets cut off", 600),
  msgRow("s6", "alice", "bob", "[file: report.pdf]", 300, { filename: "report.pdf" }),
  msgRow("s7", "alice", SLACK_U, "skipped one", 200, { key: "skip1" }),
  msgRow("s8", "bob", "alice", "hi", 100),
  msgRow("s9", "alice", "telegram-1-1", "tg msg", 50),
  msgRow("s10", "alice", SLACK_U, "unconfirmed slack", 420),
  dlvRow("d1", "s2", "delivered", 3590, { permalink: "https://x.example/p1", channel: "D1", message_ts: "1.2" }),
  dlvRow("d2a", "s3", "failed", 1790, { reason: "rate_limited" }),
  dlvRow("d2b", "s3", "delivered", 1780, { permalink: "https://x.example/p3" }),
  dlvRow("d3", "s4", "failed", 890, { reason: "channel_not_found" }),
  dlvRow("d5", "s7", "skipped", 190, { reason: "quiet hours" }),
];
// a prior send to bob inside the repeat window, an old one outside it, and a long (> index cap) one
SEEDS.repeatBase = [
  HEAD,
  msgRow("r1", "alice", "bob", "hello", 3600),
  msgRow("r2", "alice", "bob", "ancient hello", 3 * 86400),
  msgRow("r3", "bob", "alice", "great", 3500),
  msgRow("r4", "alice", "bob", LONG, 1200),
  msgRow("r5", "alice", "bob", "answer", 300, { reply_to: "zzzz" }),
];
SEEDS.pasteHeader = [
  `{\n  "type": "trajectory",\n  "step_id": "${TID}",\n  "ts": "2026-01-01T00:00:00.000Z"\n}`,
  msgRow("p1", "bob", "alice", "pretty header msg", 100),
];

const FORCE_ARGS = (extra) => ["send", "--to", "bob", ...extra];
const sentArgv = (...a) => ["sent", ...a];
const ownerOf = (sb, rf) => path.join(path.dirname(rf), "messages.jsonl.lock", "owner");
const lockOf = (rf) => path.join(path.dirname(rf), "messages.jsonl.lock");
const idxOf = (rf) => path.join(path.dirname(rf), "messages.jsonl");
// `ps -o lstart=` start time in the lock's `_`-joined spelling, for a LIVE holder record.
function psStart(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return (r.stdout ?? "").split("\n")[0].replace(/ +/g, "_").replace(/^_/, "").replace(/_$/, "");
}
// Build the index by hand exactly as a completed update would, so a scenario can then perturb it.
function prebuiltIndex(rf, { msgLines, offsetOverride } = {}) {
  const dir = path.dirname(rf);
  const traj = fs.readFileSync(rf);
  fs.writeFileSync(path.join(dir, "messages.jsonl"), (msgLines ?? []).map((l) => l + "\n").join(""));
  fs.writeFileSync(path.join(dir, "deferrals.jsonl"), "");
  fs.writeFileSync(path.join(dir, "deliveries.jsonl"), "");
  const sz = (n) => fs.statSync(path.join(dir, n)).size;
  const rec = offsetOverride ?? `${traj.length} ${TID} ${fs.statSync(rf).ino} ${traj.length} ${sz("messages.jsonl")} 0 0\n`;
  fs.writeFileSync(path.join(dir, "messages.jsonl.offset"), rec);
}
const idxScn = (name, argv, extra) => ({ group: "sync-e-index", name, argv, checkIndex: true, chatrc: RC, ...extra });

scenarios.push(
  // ---- Slack target grammar (_check_target) on send / reply / send-file / react ----
  ...[
    ["user-dm", "slack-U0BFD9NDVE3", true],
    ["workspace-user", "slack-W0ABC123", true],
    ["channel", "slack-C0BMVH6LM4K", true],
    ["private-channel", "slack-G0BMVH6LM4K", true],
    ["im-channel", "slack-D0BMVH6LM4K", true],
    ["user-channel", "slack-U0614H65RN3-D0BNW58GP5W", true],
    ["user-channel-thread", "slack-U0614H65RN3-C0BMVH6LM4K-1787508187.726149", true],
    ["lowercase-id", "slack-u0614h65rn3", false],
    ["bare", "slack-bob", false],
    ["empty-after-prefix", "slack-", false],
    ["trailing-dash", "slack-C0BMVH6LM4K-", false],
    ["thread-not-numeric", "slack-U1-C2-abc", false],
    ["four-parts", "slack-U1-C2-1.2-3", false],
    ["non-slack-name-passes", "bob-slack-U", true],
    ["telegram-passes", "telegram-8525624593-8525624593", true],
  ].map(([name, to, ok]) => ({
    group: "sync-e-target", name: `send-${name}-${ok ? "ok" : "refused"}`, argv: ["send", "--to", to, `target ${name}`], chatrc: RC,
  })),
  { group: "sync-e-target", name: "reply-invalid-slack-refused", argv: ["reply", "slack-bob", "hi"], seed: "head" },
  { group: "sync-e-target", name: "reply-valid-slack-ok", argv: ["reply", SLACK_U, "hi"], seed: "head" },
  { group: "sync-e-target", name: "react-invalid-slack-refused", argv: ["react", "slack-bob", "thumbsup"], seed: "head" },
  { group: "sync-e-target", name: "send-file-invalid-slack-refused", argv: ["send-file", "--to", "slack-bob", "f.txt"], files: [{ name: "f.txt", content: "x\n" }] },
  { group: "sync-e-target", name: "send-file-missing-file-beats-target", argv: ["send-file", "--to", "slack-bob", "nofile.txt"],
    note: "File-not-found dies before the target check (bin/chat order)" },
  { group: "sync-e-target", name: "send-file-valid-slack-ok", argv: ["send-file", "--to", SLACK_U, "f.txt"], files: [{ name: "f.txt", content: "x\n" }] },

  // ---- structured action-object refusal (_refuse_json_body) ----
  ...[
    ["action-object", '{"action":"no_reply","message":""}', false],
    ["action-object-spaced", '{ "action" : "reply", "message": "hi" }', false],
    ["pretty-printed", '{\n  "kind": "x",\n  "action": "no_reply"\n}', false],
    ["fenced", '```json\n{"action":"no_reply"}\n```', false],
    ["fenced-tilde", '~~~\n{"action": "x"}\n~~~', false],
    ["leading-blank-lines", '\n\n  {"action":"x"}', false],
    ["single-quoted-key", "{'action': 'x'}", false],
    ["escaped-quotes-key", '{\\"action\\": \\"x\\"}', false],
    ["object-without-action", '{"message":"hi","kind":"note"}', true],
    ["action-word-in-prose", "I took the action: done", true],
    ["brace-not-first-line", 'hello\n{"action":"x"}', true],
    ["array-of-actions", '[{"action":"x"}]', true],
    ["action-key-past-line-40", "{\n" + Array.from({ length: 45 }, (_, i) => `  "k${i}": ${i},`).join("\n") + '\n  "action": "x"\n}', true],
    ["action-key-at-line-40", "{\n" + Array.from({ length: 38 }, (_, i) => `  "k${i}": ${i},`).join("\n") + '\n  "action": "x"\n}', false],
    ["unquoted-action", "{action: x}", true],
  ].map(([name, body, ok]) => ({
    group: "sync-e-json", name: `send-${name}-${ok ? "ok" : "refused"}`, argv: ["send", "--to", "bob", body], chatrc: RC,
  })),
  { group: "sync-e-json", name: "send-action-object-force-ok", argv: ["send", "--force", "--to", "bob", '{"action":"no_reply"}'], chatrc: RC },
  { group: "sync-e-json", name: "send-action-object-stdin-refused", argv: ["send", "--to", "bob"], stdin: '{"action":"no_reply","message":""}\n', chatrc: RC },
  { group: "sync-e-json", name: "send-action-object-from-person-delivered-in", argv: ["send", "--from", "bob", "--to", "alice", '{"action":"x"}'], chatrc: RC,
    note: "a person's literal JSON sent INTO the identity is never refused (only our own output is guarded)" },
  { group: "sync-e-json", name: "send-action-object-no-identity-name", argv: ["send", "--from", "carol", "--to", "bob", '{"action":"x"}'], identityUnset: true,
    note: "no IDENTITY_NAME: every send counts as outbound, so it is refused" },
  { group: "sync-e-json", name: "reply-action-object-refused", argv: ["reply", "bob", '{"action":"no_reply","message":""}'], seed: "inbound" },
  { group: "sync-e-json", name: "reply-action-object-force-ok", argv: ["reply", "--force", "bob", '{"action":"no_reply"}'], seed: "inbound" },
  { group: "sync-e-json", name: "reply-plain-text-ok", argv: ["reply", "bob", "plain answer"], seed: "inbound" },

  // ---- exact-repeat refusal (_refuse_repeat) ----
  { group: "sync-e-repeat", name: "send-repeat-within-24h-refused", argv: ["send", "--to", "bob", "hello"], seed: "repeatBase", chatrc: RC },
  { group: "sync-e-repeat", name: "send-repeat-force-ok", argv: ["send", "--force", "--to", "bob", "hello"], seed: "repeatBase", chatrc: RC },
  { group: "sync-e-repeat", name: "send-different-text-ok", argv: ["send", "--to", "bob", "hello again"], seed: "repeatBase", chatrc: RC },
  { group: "sync-e-repeat", name: "send-same-text-other-destination-ok", argv: ["send", "--to", "carol", "hello"], seed: "repeatBase", chatrc: RC },
  { group: "sync-e-repeat", name: "send-repeat-outside-window-ok", argv: ["send", "--to", "bob", "ancient hello"], seed: "repeatBase", chatrc: RC },
  { group: "sync-e-repeat", name: "send-repeat-window-env-shrinks-ok", argv: ["send", "--to", "bob", "hello"], seed: "repeatBase", chatrc: RC, env: { CHAT_REPEAT_WINDOW: "30m" } },
  { group: "sync-e-repeat", name: "send-repeat-window-env-widens-refused", argv: ["send", "--to", "bob", "ancient hello"], seed: "repeatBase", chatrc: RC, env: { CHAT_REPEAT_WINDOW: "7d" } },
  { group: "sync-e-repeat", name: "send-repeat-window-zero-disables", argv: ["send", "--to", "bob", "hello"], seed: "repeatBase", chatrc: RC, env: { CHAT_REPEAT_WINDOW: "0" } },
  { group: "sync-e-repeat", name: "send-repeat-window-seconds", argv: ["send", "--to", "bob", "hello"], seed: "repeatBase", chatrc: RC, env: { CHAT_REPEAT_WINDOW: "7200" } },
  { group: "sync-e-repeat", name: "send-repeat-window-empty-defaults-24h", argv: ["send", "--to", "bob", "hello"], seed: "repeatBase", chatrc: RC, env: { CHAT_REPEAT_WINDOW: "" } },
  { group: "sync-e-repeat", name: "send-inbound-repeat-never-refused", argv: ["send", "--from", "bob", "--to", "alice", "great"], seed: "repeatBase", chatrc: RC,
    note: "2026-09-21: the repeat check must not run on a person's message delivered in" },
  { group: "sync-e-repeat", name: "send-long-exact-repeat-refused", argv: ["send", "--to", "bob", LONG], seed: "repeatBase", chatrc: RC,
    note: "text over the 8000-char index cap: the prefix match is only a candidate; the full trajectory confirms the exact repeat" },
  { group: "sync-e-repeat", name: "send-long-prefix-only-ok", argv: ["send", "--to", "bob", LONG + "-tail"], seed: "repeatBase", chatrc: RC,
    note: "same 8000-char prefix but a different tail is NOT a repeat" },
  { group: "sync-e-repeat", name: "send-repeat-stdin-refused", argv: ["send", "--to", "bob"], stdin: "hello\n", seed: "repeatBase", chatrc: RC },
  { group: "sync-e-repeat", name: "reply-unstamped-repeat-refused", argv: ["reply", "bob", "hello"], seed: "repeatBase" },
  { group: "sync-e-repeat", name: "reply-unstamped-repeat-force-ok", argv: ["reply", "--force", "bob", "hello"], seed: "repeatBase" },
  { group: "sync-e-repeat", name: "reply-stamped-same-text-within-10m-refused", argv: ["reply", "--reply-to", IN1, "bob", "answer"], seed: "repeatBase" },
  { group: "sync-e-repeat", name: "reply-stamped-24h-text-exempt", argv: ["reply", "--reply-to", IN1, "bob", "hello"], seed: "repeatBase",
    note: "a stamped reply is exempt from the 24h exact-text check (only the 10m window applies)" },
  { group: "sync-e-repeat", name: "reply-stamped-window-env-zero-ok", argv: ["reply", "--reply-to", IN1, "bob", "answer"], seed: "repeatBase", env: { CHAT_REPLY_REPEAT_WINDOW: "0" } },
  { group: "sync-e-repeat", name: "reply-stamped-window-env-1h-refused", argv: ["reply", "--reply-to", IN1, "bob", "hello"], seed: "repeatBase", env: { CHAT_REPLY_REPEAT_WINDOW: "2h" } },
  { group: "sync-e-repeat", name: "reply-inferred-stamp-exempt-from-24h", argv: ["reply", "bob", "hello"], seed: "multiInbound",
    note: "an inbound exists, so the reply is stamped (inferred): control for the unstamped-repeat refusal" },

  // ---- --key (one send per duty) ----
  { group: "sync-e-key", name: "send-key-first-ok-stamps-key", argv: ["send", "--to", "bob", "--key", "new-duty", "do it"], chatrc: RC },
  { group: "sync-e-key", name: "send-key-already-sent-refused", argv: ["send", "--to", "bob", "--key", "wk1", "reworded papers"], seed: "sentBase", chatrc: RC },
  { group: "sync-e-key", name: "send-key-already-sent-force-ok", argv: ["send", "--force", "--to", "bob", "--key", "wk1", "again"], seed: "sentBase", chatrc: RC },
  { group: "sync-e-key", name: "send-key-previous-delivered-refused", argv: ["send", "--to", "bob", "--key", "chan1", "x"], seed: "sentBase", chatrc: RC },
  { group: "sync-e-key", name: "send-key-previous-failed-ok", argv: ["send", "--to", "bob", "--key", "fail1", "retry"], seed: "sentBase", chatrc: RC },
  { group: "sync-e-key", name: "send-key-previous-skipped-ok", argv: ["send", "--to", "bob", "--key", "skip1", "retry"], seed: "sentBase", chatrc: RC },
  { group: "sync-e-key", name: "send-key-empty-value-dies", argv: ["send", "--to", "bob", "--key", "", "x"], chatrc: RC,
    note: "DOC-DEVIATION: bash ${2:?} text vs port clean msg (same class as --to '')" },
  { group: "sync-e-key", name: "send-key-missing-value-dies", argv: ["send", "--to", "bob", "x", "--key"], chatrc: RC,
    note: "DOC-DEVIATION: bash ${2:?} text vs port clean msg" },
  { group: "sync-e-key", name: "send-key-before-repeat-order", argv: ["send", "--to", "bob", "--key", "wk1", "hello"], seed: "sentBase", chatrc: RC,
    note: "both the key and the 24h-repeat checks could fire; the KEY wording must win" },

  // ---- chat sent ----
  { group: "sync-e-sent", name: "sent-text", argv: sentArgv(), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-json", argv: sentArgv("--json"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-n-limit", argv: sentArgv("-n", "3"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-n-zero", argv: sentArgv("-n", "0"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-n-zero-json", argv: sentArgv("-n", "0", "--json"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-since-10m", argv: sentArgv("--since", "10m"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-since-2h-json", argv: sentArgv("--since", "2h", "--json"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-since-seconds", argv: sentArgv("--since", "700"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-since-none-match", argv: sentArgv("--since", "1s"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-no-messages-text", argv: sentArgv(), seed: "head" },
  { group: "sync-e-sent", name: "sent-no-messages-json", argv: sentArgv("--json"), seed: "head" },
  { group: "sync-e-sent", name: "sent-only-inbound-json", argv: sentArgv("--json"), seed: "inbound" },
  { group: "sync-e-sent", name: "sent-other-identity", argv: sentArgv(), seed: "sentBase", identity: "bob" },
  { group: "sync-e-sent", name: "sent-identity-unset-defaults-agent", argv: sentArgv(), seed: "sentBase", identityUnset: true },
  { group: "sync-e-sent", name: "sent-unknown-arg-dies", argv: sentArgv("--bogus"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-bad-count-dies", argv: sentArgv("-n", "abc"), seed: "sentBase" },
  { group: "sync-e-sent", name: "sent-since-missing-value-dies", argv: sentArgv("--since"), seed: "sentBase",
    note: "DOC-DEVIATION: bash ${2:?} text vs port clean msg" },
  { group: "sync-e-sent", name: "sent-unresolvable-traj-dies", argv: sentArgv(), seed: "sentBase", env: { TRAJ_ID: "ffffffff-0000-0000-0000-000000000000" } },
  { group: "sync-e-sent", name: "sent-builds-delivery-and-key-index", argv: sentArgv("--json"), seed: "sentBase", checkIndex: true,
    note: "also compares messages.jsonl (with key), deliveries.jsonl and the .offset record bytes" },
  { group: "sync-e-sent", name: "sent-duplicate-delivery-newest-wins", argv: sentArgv("--json", "-n", "1"), checkIndex: true,
    seed: "head",
    setup: (sb, rf) => {
      fs.appendFileSync(rf, [
        msgRow("q1", "alice", SLACK_U, "dup notice", 100),
        dlvRow("e1", "q1", "failed", 90, { reason: "first" }),
        dlvRow("e2", "q1", "delivered", 80, { permalink: "https://x.example/q1" }),
        dlvRow("e3", "q1", "failed", 95, { reason: "late-written-but-older-ts" }),
      ].join("\n") + "\n");
    } },
  { group: "sync-e-sent", name: "sent-replayed-message-step-deduped", argv: sentArgv("--json"), seed: "head",
    setup: (sb, rf) => {
      const m = msgRow("q2", "alice", "bob", "replayed", 100);
      fs.appendFileSync(rf, m + "\n" + m + "\n");
    } },
  { group: "sync-e-sent", name: "sent-non-string-content-and-filename-preferred", argv: sentArgv(), seed: "head",
    setup: (sb, rf) => {
      fs.appendFileSync(rf, [
        JSON.stringify({ step_id: "n1", type: "message", from: "alice", to: "bob", content: { a: 1 }, ts: agoTs(100) }),
        JSON.stringify({ step_id: "n2", type: "message", from: "alice", to: "bob", content: "body", filename: "f.bin", ts: agoTs(90) }),
        JSON.stringify({ step_id: "n3", type: "message", from: "alice", to: "bob", content: "é".repeat(100) + "tail", ts: agoTs(80) }),
      ].join("\n") + "\n");
    } },

  // ---- the message index: header, rebuild triggers, interrupted-update trim, lock takeover, reset ----
  idxScn("index-multiline-header-stable", ["history", "--with", "bob"], { seed: "pasteHeader" }),
  idxScn("index-multiline-header-sent", ["sent", "--json"], { seed: "pasteHeader" }),
  idxScn("index-header-changed-rebuilds", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => prebuiltIndex(rf, { msgLines: ['{"step_id":"stale","from":"bob","to":"alice","content":"stale row"}'],
      offsetOverride: `1 OLD-HEADER ${fs.statSync(rf).ino} 1 1 0 0\n` }) }),
  idxScn("index-replaced-inode-rebuilds", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      const sz = fs.readFileSync(rf).length;
      prebuiltIndex(rf, { msgLines: ['{"step_id":"stale","from":"bob","to":"alice","content":"stale row"}'],
        offsetOverride: `${sz} ${TID} 1 ${sz} 60 0 0\n` });
    } }),
  idxScn("index-shrunk-below-offset-rebuilds", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => prebuiltIndex(rf, { msgLines: ['{"step_id":"stale","from":"bob","to":"alice","content":"stale row"}'],
      offsetOverride: `999999 ${TID} ${fs.statSync(rf).ino} 999999 60 0 0\n` }) }),
  idxScn("index-interrupted-update-trims-extra-rows", ["history", "--with", "bob", "--json"], { seed: "inbound",
    // non-empty recorded size: BSD head (macOS) rejects `head -c 0`, which would turn the Bash
    // side into a rebuild; GNU head (the upstream contract) truncates to 0 and carries on.
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [msgRow(IN1, "bob", "alice", "you there?", 1000)] });
      fs.appendFileSync(idxOf(rf), '{"step_id":"partial-write","from":"bob","to":"alice","content":"half"}\n{"step_id":"par');
    } }),
  idxScn("index-file-shorter-than-recorded-rebuilds", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [] });
      const sz = fs.readFileSync(rf).length;
      fs.writeFileSync(path.join(path.dirname(rf), "messages.jsonl.offset"), `${sz} ${TID} ${fs.statSync(rf).ino} ${sz} 500 0 0\n`);
    } }),
  idxScn("index-old-format-offset-upgraded", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [msgRow(IN1, "bob", "alice", "you there?", 1000)] });
      fs.writeFileSync(path.join(path.dirname(rf), "messages.jsonl.offset"), `${fs.readFileSync(rf).length} ${TID}\n`);
    } }),
  idxScn("index-old-format-missing-deliveries-rebuilds", ["sent", "--json"], { seed: "sentBase",
    setup: (sb, rf) => {
      const dir = path.dirname(rf);
      fs.writeFileSync(path.join(dir, "messages.jsonl"), "");
      fs.writeFileSync(path.join(dir, "deferrals.jsonl"), "");
      fs.writeFileSync(path.join(dir, "messages.jsonl.offset"), `0 ${TID}\n`);
    } }),
  idxScn("index-partial-last-line-left-for-next-call", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => fs.appendFileSync(rf, '{"step_id":"half","type":"message","from":"bob","to":"alice","content":"unfin') }),
  idxScn("index-only-partial-line", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [msgRow(IN1, "bob", "alice", "you there?", 1000)] });
      fs.appendFileSync(rf, '{"step_id":"half","type":"mess');
    } }),
  idxScn("index-no-new-data-releases-lock", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => prebuiltIndex(rf, { msgLines: [msgRow(IN1, "bob", "alice", "you there?", 1000)] }) }),
  idxScn("lock-dead-owner-taken-over", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), "999999 - Thu_Jan__1_00:00:00_1970\n");
    } }),
  idxScn("lock-ownerless-fresh-left-alone", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => fs.mkdirSync(lockOf(rf)) }),
  idxScn("lock-ownerless-old-taken-over", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      const old = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(lockOf(rf), old, old);
    } }),
  idxScn("lock-live-holder-left-alone", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), `${process.pid} - ${psStart(process.pid)}\n`);
      const old = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(lockOf(rf), old, old);
    } }),
  idxScn("lock-pid-reused-different-start-taken-over", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), `${process.pid} - Mon_Jan__1_00:00:00_2001\n`);
    } }),
  idxScn("lock-other-pid-namespace-never-judged", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), "1 other-namespace x\n");
    } }),
  idxScn("lock-steal-dir-fresh-blocks-takeover", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), "999999 - Thu_Jan__1_00:00:00_1970\n");
      fs.mkdirSync(lockOf(rf) + ".steal");
    } }),
  idxScn("lock-steal-dir-stale-cleared", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), "999999 - Thu_Jan__1_00:00:00_1970\n");
      fs.mkdirSync(lockOf(rf) + ".steal");
      const old = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(lockOf(rf) + ".steal", old, old);
    } }),
  idxScn("lock-held-send-repeat-check-skips-update", ["send", "--to", "bob", "hello"], { seed: "repeatBase",
    setup: (sb, rf) => {
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), `${process.pid} - ${psStart(process.pid)}\n`);
    } }),
  idxScn("reset-without-offline-dies", ["index-reset"], { seed: "inbound" }),
  idxScn("reset-extra-arg-dies", ["index-reset", "--offline", "x"], { seed: "inbound" }),
  idxScn("reset-clears-derived-files", ["index-reset", "--offline"], { seed: "sentBase",
    setup: (sb, rf) => prebuiltIndex(rf, { msgLines: [msgRow("x", "bob", "alice", "stale", 10)] }) }),
  idxScn("reset-idempotent-when-nothing-there", ["index-reset", "--offline"], { seed: "inbound" }),
  idxScn("reset-refuses-live-holder", ["index-reset", "--offline"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [] });
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), `${process.pid} - ${psStart(process.pid)}\n`);
    } }),
  idxScn("reset-dead-owner-cleared", ["index-reset", "--offline"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [] });
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(ownerOf(sb, rf), "999999 - Thu_Jan__1_00:00:00_1970\n");
    } }),
  idxScn("reset-refuses-lock-with-unknown-contents", ["index-reset", "--offline"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [] });
      fs.mkdirSync(lockOf(rf));
      fs.writeFileSync(path.join(lockOf(rf), "unexpected"), "keep");
    } }),
  idxScn("reset-refuses-symlinked-lock", ["index-reset", "--offline"], { seed: "inbound",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [] });
      const target = path.join(sb, "unrelated");
      fs.mkdirSync(target);
      fs.symlinkSync(target, lockOf(rf));
    } }),
  idxScn("reset-unremovable-index-keeps-lock", ["index-reset", "--offline"], { seed: "inbound",
    note: "DOC-DEVIATION: bash also leaks rm's own 'is a directory' stderr line (external tool wording); the chat error line is identical",
    setup: (sb, rf) => {
      prebuiltIndex(rf, { msgLines: [] });
      fs.rmSync(idxOf(rf));
      fs.mkdirSync(idxOf(rf));
    } }),
  idxScn("reset-then-history-rebuilds-note", ["history", "--with", "bob", "--json"], { seed: "inbound",
    setup: (sb, rf) => prebuiltIndex(rf, { msgLines: [] }),
    note: "control after prebuilt-empty index: cursor says up to date, so the stale-empty index is served as-is" }),
);

// --- execute ------------------------------------------------------------------
const results = [];
for (const sc of scenarios) {
  const sbBash = makeSandbox(sc);
  const sbTs = makeSandbox(sc);
  let bash, ts;
  try {
    bash = runTool("bash", sc, sbBash);
    ts = runTool("ts", sc, sbTs);
  } finally {
    fs.rmSync(sbBash, { recursive: true, force: true });
    fs.rmSync(sbTs, { recursive: true, force: true });
  }
  const bStdout = normalize(bash.stdout), tStdout = normalize(ts.stdout);
  const bStderr = scrubPaths(normalize(bash.stderr)), tStderr = scrubPaths(normalize(ts.stderr));
  const cmp = {
    stdout: bStdout === tStdout,
    stderr: bStderr === tStderr,
    status: bash.status === ts.status,
    stateRaw: bash.stateRaw === ts.stateRaw,
    stateSem: bash.stateSem === ts.stateSem,
    idxState: !sc.checkIndex || bash.idxState === ts.idxState,
  };
  const pass = cmp.stdout && cmp.stderr && cmp.status && cmp.stateRaw && cmp.idxState;
  results.push({
    group: sc.group, name: sc.name, note: sc.note, argv: sc.argv, pass, cmp,
    bash: { status: bash.status, stdoutN: bStdout, stderrN: bStderr, stateRaw: bash.stateRaw, stateSem: bash.stateSem, idxState: bash.idxState },
    ts: { status: ts.status, stdoutN: tStdout, stderrN: tStderr, stateRaw: ts.stateRaw, stateSem: ts.stateSem, idxState: ts.idxState },
  });
}
fs.rmSync(FAKEBIN, { recursive: true, force: true });

// Scrub display copies for reporting ONLY, after every `pass`/`cmp` verdict
// above has already been computed from the raw values — this cannot change a
// score.
for (const r of results) {
  for (const side of [r.bash, r.ts]) {
    if (!side) continue;
    if ("stdoutN" in side) side.stdoutN = scrubArtifactPaths(side.stdoutN);
    if ("stderrN" in side) side.stderrN = scrubArtifactPaths(side.stderrN);
    if ("stateRaw" in side) side.stateRaw = scrubArtifactPaths(side.stateRaw);
    if ("stateSem" in side) side.stateSem = scrubArtifactPaths(side.stateSem);
    if ("idxState" in side) side.idxState = scrubArtifactPaths(side.idxState);
  }
}

// --- report -------------------------------------------------------------------
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const rate = ((passed / total) * 100).toFixed(1);
function block(label, a, b, same) {
  if (same) return `    ${label}: MATCH`;
  return `    ${label}: DIFFER\n      bash: ${JSON.stringify(a)}\n      ts  : ${JSON.stringify(b)}`;
}
let md = `# chat — adversarial differential parity proof\n\n`;
md += `Real Bash \`headlong/bin/chat\` vs TS port \`headlong-ts/bin/chat.mjs\`, identical inputs in isolated sandboxes; diffed stdout + stderr + exit code + on-disk trajectory BYTES.\n\n`;
md += `- \`node run-parity.mjs\` (set \`PARITY_BASH_CHAT\`, \`PARITY_TS_REPO\`). Locale \`LC_ALL=C\`.\n`;
md += `- Real \`chat\` shells to \`traj\` (headlong/bin on PATH), \`jq\`, \`timeout\` (STUBBED coreutils passthrough so reply inference + guard run as in the Linux sandbox).\n`;
md += `- Normalized symmetrically: \`<ID>\` UUID, \`<TS>\` ISO ts, real script path -> \`<CHAT>\`. Pass = stdout+stderr+status+**stateRaw** all match.\n`;
md += `- **stateRaw** = file bytes (strict, catches escaping). **stateSem** = JSON round-trip (semantic). Both reported so escaping-only divergences are visible.\n\n`;
md += `## Result: ${passed}/${total} PARITY (${rate}%)\n\n`;
md += `| # | group | scenario | verdict | differing |\n|---|---|---|---|---|\n`;
let idx = 1;
for (const r of results) {
  const diffs = Object.entries(r.cmp).filter(([k, v]) => !v && k !== "stateSem").map(([k]) => k).join(", ") || "-";
  md += `| ${idx++} | ${r.group} | ${r.name} | ${r.pass ? "PARITY" : "DIVERGE"} | ${diffs} |\n`;
}
md += `\n## Divergences (detail)\n\n`;
const fails = results.filter((r) => !r.pass);
if (fails.length === 0) md += `None.\n`;
for (const r of fails) {
  md += `### ${r.group} / ${r.name}\n`;
  md += `- argv: \`${JSON.stringify(r.argv)}\`\n`;
  if (r.note) md += `- note: ${r.note}\n`;
  md += `- exit: bash=${r.bash.status} ts=${r.ts.status}\n`;
  md += `- stateSem (semantic on-disk): ${r.cmp.stateSem ? "MATCH" : "DIFFER"}\n`;
  md += "```\n";
  md += block("stdout", r.bash.stdoutN, r.ts.stdoutN, r.cmp.stdout) + "\n";
  md += block("stderr", r.bash.stderrN, r.ts.stderrN, r.cmp.stderr) + "\n";
  md += block("stateRaw", r.bash.stateRaw, r.ts.stateRaw, r.cmp.stateRaw) + "\n";
  md += block("idxState", r.bash.idxState, r.ts.idxState, r.cmp.idxState) + "\n";
  md += "```\n\n";
}
fs.writeFileSync(path.join(HERE, "report.md"), md);
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ total, passed, rate, results }, null, 2));

console.log(`chat parity: ${passed}/${total} (${rate}%)`);
for (const r of results) {
  if (!r.pass) {
    const diffs = Object.entries(r.cmp).filter(([k, v]) => !v && k !== "stateSem").map(([k]) => k).join(",");
    console.log(`  DIVERGE ${r.group}/${r.name}  [${diffs}]  bash_rc=${r.bash.status} ts_rc=${r.ts.status}  stateSem=${r.cmp.stateSem ? "match" : "DIFFER"}`);
  }
}
process.exit(passed === total ? 0 : 1);
