// scrub.test.ts — durable guard: no local usernames/directory names/secrets in
// tracked files.
//
// This repo is public. A committed absolute path, machine username, or leaked
// API key would deanonymize the maintainer or leak a credential. This test
// lists EVERY file `git ls-files` tracks (no exclusions — the repo must be
// clean as a whole), gunzips any `*.gz` before scanning, and fails if any of
// them contains a forbidden pattern. Scanning is byte-level (latin1: one byte
// -> one code unit, never throws on non-UTF-8 content), so it also covers
// binary assets (e.g. a PNG/ICO with a leaked path in its metadata), not just
// text files.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
}).trim();

// Forbidden substrings, stored base64-encoded and decoded at runtime. This guard's own source must not carry
// the identifiers it checks for (a plain-text grep of the repo would flag this file as the leak, and the list
// itself would publish them). Each decoded needle is a plain substring, checked with `.includes`.
const NEEDLES: string[] = [
  "L1VzZXJzL2tjd29sZmY=",
  "a2N3b2xmZg==",
  "YWdlbnQtdGVhbTM=",
  "a2NA",
  "d29sZmZjb25zdWx0aW5n",
  "c2stb3ItdjEt",
  "L3ByaXZhdGUvdG1wL2NsYXVkZQ==",
  "LVVzZXJzLQ==",
  "aGVhZGxvbmctdXBzdHJlYW0tbmV4dA==",
  "LmNsYXVkZS9jcmVkZW50aWFscw==",
  "ZGVlcGJsdWU=",
  "RGVlcEJsdWU=",
  "QXRsYW50YQ==",
  "YXRsYW50YQ==",
  "Z3Jvay1ib3Qtdm0=",
  "L2hvbWUvYm94Lw==",
].map((b) => Buffer.from(b, "base64").toString("utf8"));

const MAC_TMPDIR_RE = new RegExp("/var/" + "folders/[A-Za-z0-9_+-]{2}/[A-Za-z0-9_+-]{20,}/T\\b");

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\n").filter((l) => l.length > 0);
}

/** Raw bytes of a tracked file, gunzipped first if it's a `.gz`. */
function contentOf(rel: string): Buffer {
  const buf = fs.readFileSync(path.join(REPO_ROOT, rel));
  if (rel.endsWith(".gz")) {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      return buf; // not valid gzip after all — fall back to scanning it raw
    }
  }
  return buf;
}

describe("scrub: no local paths/usernames/secrets in tracked files", () => {
  it("no tracked file (of any kind) contains a forbidden pattern", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(0); // git ls-files sanity

    const violations: string[] = [];
    for (const rel of files) {
      const text = contentOf(rel).toString("latin1");
      for (const needle of NEEDLES) {
        if (text.includes(needle)) violations.push(`${rel}: matches "${needle}"`);
      }
      // A real macOS per-user temp dir (/var/folders/<2>/<long id>/T) is a machine fingerprint; "/var/folders/.../T"
      // in prose is fine.
      if (MAC_TMPDIR_RE.test(text)) violations.push(`${rel}: matches a macOS per-user temp dir`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
