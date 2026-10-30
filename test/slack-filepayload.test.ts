// slack-filepayload.test.ts — port of headlong/slack/tests/test_filepayload.py
// (added 692e16e). filepayload.ts has no upstream Python module before this
// sync; every case here is ported from that new upstream test file.

import { describe, it, expect } from "vitest";
import { COMMENT_MAX, filePayload, fileSignature } from "../src/slack/filepayload.ts";

describe("slack filepayload (1c: 692e16e)", () => {
  it("plain text with no filename is not a file", () => {
    expect(filePayload({ type: "message", content: "hello" })).toBeNull();
  });

  it("a filename stamps a document", () => {
    const payload = filePayload({ filename: "note.txt", content: "hi" });
    expect(payload).not.toBeNull();
    expect(payload?.filename).toBe("note.txt");
    expect(payload?.content).toBe("hi");
    expect(payload?.initialComment).toBeNull();
    expect(payload?.decodeError).toBe(false);
  });

  it("content_b64 round-trips PNG bytes", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72, 0x65, 0x73, 0x74]);
    const payload = filePayload({ filename: "fig.png", content_b64: png.toString("base64") });
    expect(payload).not.toBeNull();
    expect(Buffer.from(payload!.content as Uint8Array)).toEqual(png);
  });

  it("svg text with no filename stays plain text", () => {
    expect(filePayload({ content: "<svg xmlns='x'></svg>" })).toBeNull();
  });

  it("a path is reduced to its basename", () => {
    const payload = filePayload({ filename: "/etc/passwd", content: "x" });
    expect(payload?.filename).toBe("passwd");
  });

  it("invalid base64 is a decode error", () => {
    const payload = filePayload({ filename: "a.bin", content_b64: "@@@bad@@@", content: "[file: a.bin]" });
    expect(payload).not.toBeNull();
    expect(payload?.content).toBeNull();
    expect(payload?.decodeError).toBe(true);
  });

  it("empty content_b64 is a decode error", () => {
    const payload = filePayload({ filename: "note.txt", content_b64: "", content: "[file: note.txt]" });
    expect(payload).not.toBeNull();
    expect(payload?.content).toBeNull();
    expect(payload?.decodeError).toBe(true);
  });

  it("file signature is filename plus a content hash", () => {
    const same = fileSignature("note.txt", Buffer.from("aaa"));
    expect(same).toBe(fileSignature("note.txt", "aaa"));
    expect(same).not.toBe(fileSignature("note.txt", Buffer.from("bbb")));
    expect(same).not.toBe(fileSignature("other.txt", Buffer.from("aaa")));
  });

  it("non-string content is a decode error", () => {
    const payload = filePayload({ filename: "bad.bin", content: { x: "y" } });
    expect(payload).not.toBeNull();
    expect(payload?.content).toBeNull();
    expect(payload?.decodeError).toBe(true);
  });

  it("the `file` alias is ignored — only `filename` stamps a document", () => {
    expect(filePayload({ file: "note.txt", content: "hi" })).toBeNull();
    const payload = filePayload({ filename: "note.txt", file: "other.bin", content: "hi" });
    expect(payload?.filename).toBe("note.txt");
  });

  it("caption and text content are leak-filtered", () => {
    const payload = filePayload({
      filename: "note.txt",
      content: "chat reply slack-U1-C1 secret notes",
      caption: "chat reply slack-U1-C1 look",
    });
    expect(payload?.content).toBe("secret notes");
    expect(payload?.initialComment).toBe("look");
  });

  it("a caption is truncated to COMMENT_MAX", () => {
    const payload = filePayload({ filename: "a.txt", content: "x", caption: "c".repeat(COMMENT_MAX + 50) });
    expect(payload?.initialComment).toBe("c".repeat(COMMENT_MAX));
  });
});
