// tar-writer.test.ts — src/tar.ts's writeTarGz: ustar for short names, PAX
// "path"/"linkpath" extended headers for anything over the 100-byte ustar
// name/linkname field (used by identityExport for deep trajectory paths).
// Round-trips through this port's own reader; also spot-checked against the
// real system `tar` in the export differential harness
// (parity/identity/run-export-parity.mjs), which decodes real Bash-produced
// archives that legitimately use both ustar and PAX-style long names.

import { describe, it, expect } from "vitest";
import { writeTarGz, readTarGz, type TarWriteEntry } from "../src/tar.ts";

describe("writeTarGz — short names (ustar)", () => {
  it("round-trips file/directory/symlink with real modes", () => {
    const entries: TarWriteEntry[] = [
      { name: "short.txt", type: "file", data: Buffer.from("hi"), mode: 0o644 },
      { name: "exe", type: "file", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
      { name: "dir/", type: "directory", mode: 0o755 },
      { name: "dir/link", type: "symlink", linkname: "/some/target", mode: 0o777 },
    ];
    const decoded = readTarGz(writeTarGz(entries));
    expect(decoded).toHaveLength(4);
    const byName = new Map(decoded.map((e) => [e.name, e]));
    expect(byName.get("short.txt")!.data.toString()).toBe("hi");
    expect(byName.get("short.txt")!.mode).toBe(0o644);
    expect(byName.get("exe")!.mode).toBe(0o755);
    expect(byName.get("dir/")!.type).toBe("directory");
    expect(byName.get("dir/link")!.type).toBe("symlink");
    expect(byName.get("dir/link")!.linkname).toBe("/some/target");
  });
});

describe("writeTarGz — long names (PAX)", () => {
  it("round-trips a name over 100 bytes", () => {
    const longName = `${"a/".repeat(60)}file.txt`; // well over 100 bytes
    expect(Buffer.byteLength(longName, "utf-8")).toBeGreaterThan(100);
    const decoded = readTarGz(writeTarGz([{ name: longName, type: "file", data: Buffer.from("content"), mode: 0o600 }]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.name).toBe(longName);
    expect(decoded[0]!.data.toString()).toBe("content");
    expect(decoded[0]!.mode).toBe(0o600);
  });

  it("round-trips a symlink with a long linkname", () => {
    const longTarget = `/very/deep/${"nested/".repeat(20)}target`;
    expect(Buffer.byteLength(longTarget, "utf-8")).toBeGreaterThan(100);
    const decoded = readTarGz(writeTarGz([{ name: "link", type: "symlink", linkname: longTarget, mode: 0o777 }]));
    expect(decoded[0]!.linkname).toBe(longTarget);
  });

  it("a long name doesn't corrupt a short-named entry that follows it", () => {
    const longName = `${"x".repeat(150)}.txt`;
    const decoded = readTarGz(
      writeTarGz([
        { name: longName, type: "file", data: Buffer.from("first"), mode: 0o644 },
        { name: "short.txt", type: "file", data: Buffer.from("second"), mode: 0o644 },
      ])
    );
    expect(decoded).toHaveLength(2);
    expect(decoded[1]!.name).toBe("short.txt");
    expect(decoded[1]!.data.toString()).toBe("second");
  });

  it("unicode content in a long name survives byte-exact", () => {
    const longName = `${"café-résumé-日本語-".repeat(6)}end.md`;
    const decoded = readTarGz(writeTarGz([{ name: longName, type: "file", data: Buffer.from("ok"), mode: 0o644 }]));
    expect(decoded[0]!.name).toBe(longName);
  });
});
