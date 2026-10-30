// lib/gen.mjs — hostile/boundary string+byte generators shared by every
// tool's scenario generator. Pure functions of an Rng (lib/rng.mjs) so a
// fixed --seed reproduces byte-identical fuzz input.

// --- boundary byte-string library (named, so findings can cite which one hit) --
export const NAMED_BYTES = {
  empty: () => Buffer.alloc(0),
  "1-byte": () => Buffer.from("x"),
  "64kb": () => Buffer.alloc(64 * 1024, 0x41), // 'A' * 64KiB
  "1mb": () => Buffer.alloc(1024 * 1024, 0x42), // 'B' * 1MiB
  nul: () => Buffer.from([0x41, 0x00, 0x42]), // A NUL B
  del: () => Buffer.from([0x41, 0x7f, 0x42]), // A DEL B
  "invalid-utf8": () => Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xed, 0xa0, 0x80]), // BOM-ish, overlong, lone surrogate
  crlf: () => Buffer.from("line1\r\nline2\r\n"),
  "leading-dash": () => Buffer.from("-x"),
  "double-dash": () => Buffer.from("--"),
  spaces: () => Buffer.from("  has  spaces  "),
  "single-quote": () => Buffer.from("it's a 'quoted' value"),
  "double-quote": () => Buffer.from('say "hi" please'),
  backtick: () => Buffer.from("`whoami`"),
  dollar: () => Buffer.from("$(whoami) ${HOME}"),
  dotdot: () => Buffer.from("../../../etc/passwd"),
  "abs-path": () => Buffer.from("/etc/passwd"),
  newline: () => Buffer.from("line one\nline two\nline three"),
  emoji: () => Buffer.from("café — 日本語 😀 memo"),
  "unicode-nfc-nfd": () => Buffer.from("café vs café"),
  tab: () => Buffer.from("a\tb\tc"),
  "trailing-newline": () => Buffer.from("content\n"),
  "no-trailing-newline": () => Buffer.from("content"),
};

export const NAMED_BYTE_KEYS = Object.keys(NAMED_BYTES);

export function namedBytes(name) {
  const f = NAMED_BYTES[name];
  if (!f) throw new Error(`unknown named byte fixture: ${name}`);
  return f();
}

export function randomBytesFixture(rng) {
  return rng.pick(NAMED_BYTE_KEYS);
}

// argv elements can never contain a NUL byte on any OS (execve()'s argv is
// NUL-terminated C strings; Node's spawnSync/spawn throw ERR_INVALID_ARG_VALUE
// for one) — this is a real, universal OS restriction, not a tool-specific
// contract, so it is never a meaningful thing to fuzz THROUGH argv (NUL is
// still fully exercised via stdin/file content, where it's a legitimate probe).
const ARGV_SAFE_KEYS = NAMED_BYTE_KEYS.filter((k) => k !== "nul");
export function randomArgvBytesFixture(rng) {
  return rng.pick(ARGV_SAFE_KEYS);
}

// --- random printable-ish strings for "valid" fuzzing (flag values, names) ----
const WORDISH = ["foo", "bar", "baz", "qux", "alpha", "bravo", "note", "task", "memo", "x", "a1", "z9", "test-name", "my_thing"];
export function randomWord(rng) {
  return rng.pick(WORDISH) + (rng.bool(0.3) ? String(rng.int(0, 999)) : "");
}
export function randomSentence(rng, minWords = 1, maxWords = 8) {
  const n = rng.int(minWords, maxWords);
  const words = [];
  for (let i = 0; i < n; i++) words.push(randomWord(rng));
  return words.join(" ");
}

// --- hostile path-shape generator: leading dash, spaces, quotes, .., abs, etc --
// ".." depth capped at 2: every sandbox this fuzzer builds nests the tool's
// cwd exactly one level under a private throwaway root (root/work/, see
// lib/sandbox.mjs's makeRootWorkSandbox / put.mjs's isolation note) — "../.."
// from cwd reaches that root and stops there; a 3rd ".." would escape the
// root itself onto the real machine's tmp directory, which an earlier
// version of parity/fuzz/tools/glob.mjs actually hit (real macOS system
// paths, "Operation not permitted" spam) before this cap was added.
const PATH_HOSTILE_SEGMENTS = [
  "..", "../..", "-x", "--", "-", " leading-space", "trailing-space ",
  "with space", "with'quote", 'with"quote', "with`tick", "with$dollar", "a//b",
  "./a/./b", "a/../b", ".hidden", "..hidden2dots", "UPPER", "MiXeD",
  "very-" + "long-".repeat(20) + "name",
];
export function hostilePathSegment(rng) {
  return rng.pick(PATH_HOSTILE_SEGMENTS);
}
export function hostileRelPath(rng, ext = ".txt") {
  const depth = rng.int(0, 3);
  const parts = [];
  for (let i = 0; i < depth; i++) parts.push(hostilePathSegment(rng).replace(/\//g, "_"));
  parts.push(randomWord(rng) + ext);
  return parts.join("/");
}

// --- flag-value mutators: empty, missing, garbage, negative, huge, non-integer -
export function integerish(rng) {
  return rng.pickWeighted([
    [String(rng.int(0, 100)), 6],
    ["0", 2],
    ["-1", 2],
    [String(rng.int(-1000, -1)), 1],
    ["+2", 1],
    ["", 2],
    ["abc", 2],
    ["1+1", 1],
    ["10x", 1],
    ["99999999999999999999", 1],
    [" 5", 1],
    ["5 ", 1],
    ["0x10", 1],
    ["NaN", 1],
  ]);
}

// --- concurrency helper: N in [2,4] ---
export function concurrencyN(rng) {
  return rng.int(2, 4);
}

export default {
  NAMED_BYTES,
  NAMED_BYTE_KEYS,
  namedBytes,
  randomBytesFixture,
  randomWord,
  randomSentence,
  hostilePathSegment,
  hostileRelPath,
  integerish,
  concurrencyN,
};
