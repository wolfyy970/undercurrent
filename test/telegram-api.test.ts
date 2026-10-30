// telegram-api.test.ts — port of headlong/telegram/tests/test_api.py.
//
// Bot.call's error contract: every failure arrives as ApiError. The module
// docstring promises callers that a call either returns `result` or raises
// ApiError. The poll loop leans on that promise — it retries on
// (ApiError, HttpError) and dies on anything else — so a failure shape that
// escapes those two takes the bridge down.

import { describe, it, expect } from "vitest";
import { ApiError, Bot, type FetchLike } from "../src/telegram/api.ts";

function botReturning(factory: () => Response): Bot {
  const fetchImpl: FetchLike = async () => factory();
  return new Bot("t", { fetchImpl });
}

describe("telegram api Bot", () => {
  it("non-JSON body raises ApiError", async () => {
    // A 502 HTML page from an edge/proxy, not a Telegram JSON error.
    const bot = botReturning(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(bot.getUpdates(0)).rejects.toBeInstanceOf(ApiError);
  });

  it("JSON error status raises ApiError", async () => {
    // A 500 whose body is valid JSON but carries no ok/description.
    const bot = botReturning(() => new Response(JSON.stringify({ oops: true }), { status: 500 }));
    await expect(bot.getUpdates(0)).rejects.toBeInstanceOf(ApiError);
  });

  it("ok:false still raises ApiError with description", async () => {
    const bot = botReturning(
      () => new Response(JSON.stringify({ ok: false, description: "Conflict" }), { status: 200 }),
    );
    await expect(bot.getUpdates(0)).rejects.toThrow(/Conflict/);
  });

  it("ok:true returns result", async () => {
    const bot = botReturning(
      () => new Response(JSON.stringify({ ok: true, result: [1, 2] }), { status: 200 }),
    );
    await expect(bot.getUpdates(0)).resolves.toEqual([1, 2]);
  });

  // -- 06f1588: sendDocument/sendPhoto go out as multipart/form-data -------

  it("sendDocument posts the file as multipart/form-data", async () => {
    let captured: { init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = { init };
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    };
    const bot = new Bot("t", { fetchImpl });
    await bot.sendDocument(42, Buffer.from("hello"), "note.txt", "a caption");

    expect(captured!.init.body).toBeInstanceOf(FormData);
    const form = captured!.init.body as FormData;
    expect(form.get("chat_id")).toBe("42");
    expect(form.get("caption")).toBe("a caption");
    const file = form.get("document") as File;
    expect(file.name).toBe("note.txt");
    expect(await file.text()).toBe("hello");
  });

  it("sendPhoto omits caption when not given", async () => {
    let captured: { init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = { init };
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    };
    const bot = new Bot("t", { fetchImpl });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await bot.sendPhoto(7, png, "fig.png");

    const form = captured!.init.body as FormData;
    expect(form.get("chat_id")).toBe("7");
    expect(form.get("caption")).toBeNull();
    const file = form.get("photo") as File;
    expect(file.name).toBe("fig.png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
  });

  it("sendDocument raises ApiError on a rejected upload", async () => {
    const bot = botReturning(
      () => new Response(JSON.stringify({ ok: false, description: "PAYLOAD_TOO_BIG" }), { status: 200 }),
    );
    await expect(bot.sendDocument(1, Buffer.from("x"), "a.bin")).rejects.toBeInstanceOf(ApiError);
  });
});
