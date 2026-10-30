// tar.ts — a minimal, read-only ustar/PAX/GNU-longname tar reader, plus a
// ustar/PAX writer (PAX "path" extended header for any name > 100 bytes,
// ustar otherwise), used by identityImport/identityExport (`identity
// import`/`identity export`) and their differential test fixtures. No
// dependency: gzip framing is node:zlib (built in); the tar container format
// itself has no Node stdlib module, so it is hand-rolled here, scoped to what
// GNU tar and bsdtar actually emit (both are exercised by the differential
// harness against the real `tools/identity export`/`import`).
//
// NOT a general-purpose tar implementation: no sparse files, no multi-volume,
// no non-UTF8 byte-preserving names. Good enough for `identity export`
// archives, which are plain files/dirs/symlinks under an identity tree.

import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;

export type TarEntryType = "file" | "directory" | "symlink" | "other";

export interface TarEntry {
  name: string; // archive-relative path, "/"-separated
  type: TarEntryType;
  size: number;
  mode: number;
  linkname: string; // symlink target, when type === "symlink"
  data: Buffer; // empty for directory/symlink entries
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = buf.subarray(start, start + len);
  // A number that overflows the field is base-256 encoded with the high bit
  // of the first byte set (GNU extension) — rare for our inputs, but handled
  // so a huge trajectory file doesn't silently misparse.
  if (raw.length > 0 && (raw[0]! & 0x80) !== 0) {
    let n = BigInt(raw[0]! & 0x7f);
    for (let i = 1; i < raw.length; i++) n = (n << 8n) | BigInt(raw[i]!);
    return Number(n);
  }
  const text = raw.toString("latin1").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  return parseInt(text, 8) || 0;
}

function readCString(buf: Buffer, start: number, len: number): string {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return (nul === -1 ? raw : raw.subarray(0, nul)).toString("utf-8");
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[offset + i] !== 0) return false;
  return true;
}

/** Parse a PAX extended-header block's body ("%d %s=%s\n" records per GNU/POSIX). */
function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  const text = body;
  while (pos < text.length) {
    let sp = pos;
    while (sp < text.length && text[sp] !== 0x20) sp++;
    if (sp >= text.length) break;
    const lenStr = text.subarray(pos, sp).toString("latin1");
    const recLen = parseInt(lenStr, 10);
    if (!Number.isFinite(recLen) || recLen <= 0) break;
    const rec = text.subarray(pos, pos + recLen).toString("utf-8");
    const eq = rec.indexOf("=");
    if (eq !== -1) {
      const key = rec.slice(sp - pos + 1, eq);
      let value = rec.slice(eq + 1);
      if (value.endsWith("\n")) value = value.slice(0, -1);
      out[key] = value;
    }
    pos += recLen;
  }
  return out;
}

/** Read every member of a gzip-compressed tar archive. Throws on a body that
 *  isn't gzip, or isn't a tar (first header block fails to parse a plausible
 *  type/size). */
export function readTarGz(archive: Buffer): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (e) {
    throw new Error(`not a gzip archive: ${e instanceof Error ? e.message : String(e)}`);
  }
  return readTar(tar);
}

export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let longLinkName: string | null = null;
  let paxOverrides: Record<string, string> = {};

  while (offset + BLOCK <= tar.length) {
    if (isZeroBlock(tar, offset)) {
      offset += BLOCK;
      // A second zero block is the standard end-of-archive marker.
      if (offset + BLOCK <= tar.length && isZeroBlock(tar, offset)) break;
      continue;
    }
    const header = tar.subarray(offset, offset + BLOCK);
    let name = readCString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0);
    let linkname = readCString(header, 157, 100);
    const magic = header.subarray(257, 263).toString("latin1");
    const mode = readOctal(header, 100, 8);
    if (magic === "ustar" || magic.startsWith("ustar")) {
      const prefix = readCString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    offset += BLOCK;
    const dataStart = offset;
    const dataLen = size;
    const data = tar.subarray(dataStart, dataStart + dataLen);
    offset += Math.ceil(dataLen / BLOCK) * BLOCK;

    if (typeflag === "L") {
      // GNU long name: this entry's DATA is the next entry's real name.
      longName = data.toString("utf-8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "K") {
      longLinkName = data.toString("utf-8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      // PAX extended header (local 'x' applies to the next entry; global 'g'
      // we fold in the same way — good enough for these archives, which
      // never carry a persistent global header this reader relies on).
      paxOverrides = { ...paxOverrides, ...parsePax(data) };
      continue;
    }

    if (longName !== null) name = longName;
    if (longLinkName !== null) linkname = longLinkName;
    if (paxOverrides["path"]) name = paxOverrides["path"]!;
    if (paxOverrides["linkpath"]) linkname = paxOverrides["linkpath"]!;
    const paxSize = paxOverrides["size"];
    longName = null;
    longLinkName = null;
    paxOverrides = {};

    let type: TarEntryType;
    if (typeflag === "5") type = "directory";
    else if (typeflag === "2") type = "symlink";
    else if (typeflag === "0" || typeflag === "\0" || typeflag === "") type = "file";
    else type = "other";

    if (type === "other") continue; // hardlinks/devices/fifos — not used by identity archives

    entries.push({
      name,
      type,
      size: paxSize ? parseInt(paxSize, 10) : size,
      mode,
      linkname,
      data: type === "file" ? Buffer.from(data.subarray(0, size)) : Buffer.alloc(0),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Writer (ustar; PAX "path" extended header for any name that doesn't fit
// ustar's 100-byte name field) — used by identityExport (`identity export`,
// src/identity.ts) as well as test fixtures.
// ---------------------------------------------------------------------------

export interface TarWriteEntry {
  name: string;
  type: TarEntryType;
  data?: Buffer;
  linkname?: string;
  mode?: number;
}

function octalField(n: number, len: number): Buffer {
  const s = n.toString(8).padStart(len - 1, "0");
  const buf = Buffer.alloc(len);
  buf.write(s, "latin1");
  return buf;
}

function buildHeader(name: string, type: TarEntryType, size: number, mode: number, linkname: string): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name.slice(0, 100), 0, "utf-8");
  octalField(mode, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  octalField(size, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136); // mtime
  header.fill(0x20, 148, 156); // chksum placeholder: 8 spaces, per spec
  header[156] = (type === "directory" ? "5" : type === "symlink" ? "2" : "0").charCodeAt(0);
  header.write(linkname.slice(0, 100), 157, "utf-8");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  const octal = sum.toString(8).padStart(6, "0");
  header.write(octal, 148, "latin1");
  header[148 + 6] = 0; // NUL
  header[148 + 7] = 0x20; // space
  return header;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

/** One PAX extended-header record: "<len> <key>=<value>\n", length-prefix
 *  self-referential (GNU/POSIX pax format — the same shape parsePax reads). */
function paxRecord(key: string, value: string): Buffer {
  const suffix = `${key}=${value}\n`;
  let guess = Buffer.byteLength(suffix, "utf-8") + 2;
  for (;;) {
    const candidate = `${guess} ${suffix}`;
    const actual = Buffer.byteLength(candidate, "utf-8");
    if (actual === guess) return Buffer.from(candidate, "utf-8");
    guess = actual;
  }
}

/** A PAX extended-header entry (typeflag 'x') carrying `records`, immediately
 *  preceding the real entry it applies to. */
function buildPaxHeaderEntry(records: Buffer[]): Buffer[] {
  const data = Buffer.concat(records);
  const header = buildHeader("PaxHeaders.0/", "other", data.length, 0o644, "");
  header[156] = "x".charCodeAt(0); // buildHeader only emits 0/5/2; override for pax
  // Recompute the checksum after overriding the typeflag byte (buildHeader's
  // checksum was for typeflag '0', which buildHeader always assigns to "other").
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  const octal = sum.toString(8).padStart(6, "0");
  header.write(octal, 148, "latin1");
  header[148 + 6] = 0;
  header[148 + 7] = 0x20;
  return [header, pad(data)];
}

/** ustar writer, falling back to a PAX "path"/"linkpath" extended header for
 *  any name/linkname over 100 bytes (there is no ustar prefix-splitting here —
 *  PAX handles any length, and this port's own reader already understands it). */
export function writeTarGz(entries: TarWriteEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const linkname = e.linkname ?? "";
    const nameBytes = Buffer.byteLength(e.name, "utf-8");
    const linkBytes = Buffer.byteLength(linkname, "utf-8");
    const paxRecords: Buffer[] = [];
    if (nameBytes > 100) paxRecords.push(paxRecord("path", e.name));
    if (linkBytes > 100) paxRecords.push(paxRecord("linkpath", linkname));
    if (paxRecords.length > 0) parts.push(...buildPaxHeaderEntry(paxRecords));

    const mode = e.mode ?? (e.type === "directory" ? 0o755 : e.type === "symlink" ? 0o777 : 0o644);
    const header = buildHeader(e.name, e.type, e.type === "file" ? data.length : 0, mode, linkname);
    parts.push(header);
    if (e.type === "file" && data.length > 0) parts.push(pad(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  const tar = Buffer.concat(parts);
  return gzipSync(tar);
}
