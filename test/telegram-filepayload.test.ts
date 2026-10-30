// telegram-filepayload.test.ts — port of
// headlong/telegram/tests/test_filepayload.py (06f1588, a2cf670, ab13bab,
// 2827421, f68ae29, c647609, 21c62ba).

import { describe, it, expect } from "vitest";
import { CAPTION_MAX, filePayload, fileSignature } from "../src/telegram/filepayload.ts";

describe("telegram filepayload", () => {
  it("plain text is not a file", () => {
    expect(filePayload({ type: "message", content: "hello" })).toBeNull();
  });

  it("filename stamps a document", () => {
    const payload = filePayload({ filename: "note.txt", content: "hi" });
    expect(payload).not.toBeNull();
    expect(payload!.filename).toBe("note.txt");
    expect(payload!.content).toBe("hi");
    expect(payload!.asPhoto).toBe(false);
    expect(payload!.caption).toBeNull();
  });

  it("content_b64 roundtrips PNG bytes", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
    const payload = filePayload({ filename: "fig.png", content_b64: png.toString("base64") });
    expect(payload).not.toBeNull();
    expect(payload!.content).toEqual(png);
    expect(payload!.asPhoto).toBe(true);
  });

  it("svg without filename stays text", () => {
    expect(filePayload({ content: "<svg xmlns='x'></svg>" })).toBeNull();
  });

  it("path is reduced to basename", () => {
    const payload = filePayload({ filename: "/etc/passwd", content: "x" });
    expect(payload).not.toBeNull();
    expect(payload!.filename).toBe("passwd");
  });

  it("invalid b64 is not a file (decode error)", () => {
    const payload = filePayload({ filename: "a.bin", content_b64: "!!!!" });
    expect(payload).not.toBeNull();
    expect(payload!.content).toBeNull();
    expect(payload!.decodeError).toBe(true);
  });

  it("caption is truncated", () => {
    const payload = filePayload({ filename: "a.txt", content: "x", caption: "c".repeat(2000) });
    expect(payload).not.toBeNull();
    expect(payload!.caption).toBe("c".repeat(CAPTION_MAX));
  });

  it("file alias is ignored", () => {
    // Canonical key is `filename`. A stray `file` field must not
    // reclassify an ordinary message as an upload.
    expect(filePayload({ file: "note.txt", content: "hi" })).toBeNull();
    const payload = filePayload({ filename: "note.txt", file: "other.bin", content: "hi" });
    expect(payload).not.toBeNull();
    expect(payload!.filename).toBe("note.txt");
  });

  it("caption and text content are leak-filtered", () => {
    const payload = filePayload({
      filename: "note.txt",
      content: "chat reply telegram-1-2 secret notes",
      caption: "chat reply telegram-1-2 look",
    });
    expect(payload).not.toBeNull();
    expect(payload!.content).toBe("secret notes");
    expect(payload!.caption).toBe("look");
  });

  it("jpeg uses photo", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("rest")]);
    const payload = filePayload({ filename: "shot.jpg", content_b64: jpeg.toString("base64") });
    expect(payload).not.toBeNull();
    expect(payload!.content).toEqual(jpeg);
    expect(payload!.asPhoto).toBe(true);
  });

  it("text content is never a photo", () => {
    const payload = filePayload({ filename: "fig.png", content: "not-bytes" });
    expect(payload).not.toBeNull();
    expect(payload!.asPhoto).toBe(false);
  });

  it("invalid content_b64 is a decode error", () => {
    const payload = filePayload({
      filename: "note.txt",
      content_b64: "@@@not-base64@@@",
      content: "[file: note.txt]",
    });
    expect(payload).not.toBeNull();
    expect(payload!.content).toBeNull();
    expect(payload!.decodeError).toBe(true);
  });

  it("empty content_b64 is a decode error", () => {
    const payload = filePayload({
      filename: "note.txt",
      content_b64: "",
      content: "[file: note.txt]",
    });
    expect(payload).not.toBeNull();
    expect(payload!.content).toBeNull();
    expect(payload!.decodeError).toBe(true);
  });

  it("file_signature is filename plus content hash", () => {
    const same = fileSignature("note.txt", Buffer.from("aaa"));
    expect(same).toBe(fileSignature("note.txt", "aaa"));
    expect(same).not.toBe(fileSignature("note.txt", Buffer.from("bbb")));
    expect(same).not.toBe(fileSignature("other.txt", Buffer.from("aaa")));
  });

  it("non-string content is a decode error", () => {
    const payload = filePayload({ filename: "bad.bin", content: { x: "y" } });
    expect(payload).not.toBeNull();
    expect(payload!.content).toBeNull();
    expect(payload!.decodeError).toBe(true);
  });
});
