// slack-api.test.ts — no upstream Python test file exists for this module
// (headlong_slack has no api.py of its own; it is a pure client of
// slack_bolt's WebClient — see api.ts's file header). These cases exercise
// the from-scratch WebClient against an injected fetchImpl.

import { describe, it, expect } from "vitest";
import { WebClient, SlackApiError, HttpError } from "../src/slack/api.ts";

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("slack api WebClient", () => {
  it("authTest posts to auth.test with a bearer token and returns the payload", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = fakeFetch((url, init) => {
      seen = { url, init };
      return { body: { ok: true, user_id: "U0BOT", user: "audel" } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    const res = await client.authTest();
    expect(res).toEqual({ ok: true, user_id: "U0BOT", user: "audel" });
    expect(seen!.url).toBe("https://slack.com/api/auth.test");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-t");
    expect((seen!.init.headers as Record<string, string>)["content-type"]).toContain(
      "application/x-www-form-urlencoded",
    );
  });

  it("usersInfo sends user= and unwraps result.user", async () => {
    let body = "";
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body);
      return { body: { ok: true, user: { id: "U1", real_name: "Dana" } } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    const user = await client.usersInfo("U1");
    expect(user).toEqual({ id: "U1", real_name: "Dana" });
    expect(new URLSearchParams(body).get("user")).toBe("U1");
  });

  it("conversationsInfo sends channel= and unwraps result.channel", async () => {
    const fetchImpl = fakeFetch(() => ({ body: { ok: true, channel: { id: "C1", name: "eng" } } }));
    const client = new WebClient("xoxb-t", { fetchImpl });
    const chan = await client.conversationsInfo("C1");
    expect(chan).toEqual({ id: "C1", name: "eng" });
  });

  it("chatPostMessage sends a JSON body with channel/text/thread_ts/unfurl_links", async () => {
    let body = "";
    let contentType = "";
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body);
      contentType = (init.headers as Record<string, string>)["content-type"] ?? "";
      return { body: { ok: true } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    await client.chatPostMessage("C1", "hello", { threadTs: "1.1", unfurlLinks: false });
    expect(contentType).toContain("application/json");
    // JSON, not form: unfurl_links stays a real boolean, not "0"/"1" or "false".
    expect(JSON.parse(body)).toEqual({ channel: "C1", text: "hello", thread_ts: "1.1", unfurl_links: false });
  });

  it("chatPostMessage omits thread_ts when null (top-level DM reply)", async () => {
    let body = "";
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body);
      return { body: { ok: true } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    await client.chatPostMessage("D1", "hi", { threadTs: null });
    expect(JSON.parse(body)).not.toHaveProperty("thread_ts");
  });

  it("appsConnectionsOpen returns the wss url", async () => {
    const fetchImpl = fakeFetch(() => ({ body: { ok: true, url: "wss://example/link" } }));
    const client = new WebClient("xapp-t", { fetchImpl });
    expect(await client.appsConnectionsOpen()).toBe("wss://example/link");
  });

  it("throws SlackApiError on ok:false", async () => {
    const fetchImpl = fakeFetch(() => ({ body: { ok: false, error: "invalid_auth" } }));
    const client = new WebClient("bad", { fetchImpl });
    await expect(client.authTest()).rejects.toThrow(SlackApiError);
    await expect(client.authTest()).rejects.toThrow(/invalid_auth/);
  });

  it("throws SlackApiError on a non-JSON response", async () => {
    const fetchImpl = async () => new Response("<html>oops</html>", { status: 502 });
    const client = new WebClient("t", { fetchImpl });
    await expect(client.authTest()).rejects.toThrow(SlackApiError);
  });

  it("throws HttpError when the transport itself fails", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = new WebClient("t", { fetchImpl });
    await expect(client.authTest()).rejects.toThrow(HttpError);
  });

  // -- 1c: ed0b700, d5cc776, 6a98ab5 — reactions.get / conversations.replies / reactions.add

  it("reactionsGet sends channel/timestamp form-encoded and returns the payload", async () => {
    let body = "";
    let contentType = "";
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body);
      contentType = (init.headers as Record<string, string>)["content-type"] ?? "";
      return { body: { ok: true, message: { ts: "1.1", thread_ts: "1.0" } } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    const res = await client.reactionsGet("C1", "1.1");
    expect(contentType).toContain("application/x-www-form-urlencoded");
    expect(new URLSearchParams(body).get("channel")).toBe("C1");
    expect(new URLSearchParams(body).get("timestamp")).toBe("1.1");
    expect(res).toEqual({ ok: true, message: { ts: "1.1", thread_ts: "1.0" } });
  });

  it("conversationsReplies sends channel/ts/latest/inclusive/limit/cursor form-encoded", async () => {
    let body = "";
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body);
      return { body: { ok: true, messages: [] } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    await client.conversationsReplies({ channel: "C1", ts: "1.0", latest: "1.5", inclusive: false, limit: 3, cursor: "abc" });
    const params = new URLSearchParams(body);
    expect(params.get("channel")).toBe("C1");
    expect(params.get("ts")).toBe("1.0");
    expect(params.get("latest")).toBe("1.5");
    // params= booleans convert to "0"/"1", not "true"/"false" (slack_sdk's
    // convert_bool_to_0_or_1 — see api.ts's callForm PORT-NOTE).
    expect(params.get("inclusive")).toBe("0");
    expect(params.get("limit")).toBe("3");
    expect(params.get("cursor")).toBe("abc");
  });

  it("reactionsAdd sends channel/timestamp/name form-encoded", async () => {
    let body = "";
    const fetchImpl = fakeFetch((_url, init) => {
      body = String(init.body);
      return { body: { ok: true } };
    });
    const client = new WebClient("xoxb-t", { fetchImpl });
    await client.reactionsAdd("C1", "1.1", "thumbsup");
    const params = new URLSearchParams(body);
    expect(params.get("channel")).toBe("C1");
    expect(params.get("timestamp")).toBe("1.1");
    expect(params.get("name")).toBe("thumbsup");
  });

  // -- 1c: 692e16e — files.upload_v2's 3-call flow

  it("filesUploadV2 calls getUploadURLExternal, raw-POSTs bytes, then completeUploadExternal in order", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const content = new TextEncoder().encode("hello file");
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, method: init.method ?? "GET", body: init.body });
      if (url.endsWith("/files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, file_id: "F1", upload_url: "https://upload.test/put/F1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://upload.test/put/F1") {
        return new Response("OK", { status: 200 });
      }
      if (url.endsWith("/files.completeUploadExternal")) {
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const client = new WebClient("xoxb-t", { fetchImpl });
    const res = await client.filesUploadV2({ channel: "C1", filename: "note.txt", content, threadTs: "1.0", initialComment: "hi" });
    expect(res).toEqual({ ok: true, files: [{ id: "F1" }] });
    expect(calls.map((c) => c.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://upload.test/put/F1",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
    // step1: filename + byte length
    const step1Params = new URLSearchParams(String(calls[0]!.body));
    expect(step1Params.get("filename")).toBe("note.txt");
    expect(step1Params.get("length")).toBe(String(content.length));
    // step2: raw bytes, no slack.com/api prefix, no auth header re-asserted here (fetchImpl still sees whatever headers api.ts sent)
    expect(calls[1]!.body).toBe(content);
    // step3: files= is a JSON-stringified [{id, title}] array, plus channel_id/thread_ts/initial_comment
    const step3Params = new URLSearchParams(String(calls[2]!.body));
    expect(JSON.parse(step3Params.get("files")!)).toEqual([{ id: "F1", title: "note.txt" }]);
    expect(step3Params.get("channel_id")).toBe("C1");
    expect(step3Params.get("thread_ts")).toBe("1.0");
    expect(step3Params.get("initial_comment")).toBe("hi");
  });

  it("filesUploadV2 throws HttpError when the raw upload step returns non-2xx", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith("/files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, file_id: "F1", upload_url: "https://upload.test/put/F1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://upload.test/put/F1") {
        return new Response("nope", { status: 500 });
      }
      throw new Error(`unexpected url ${url} (completeUploadExternal must not be called after a failed upload)`);
    };
    const client = new WebClient("xoxb-t", { fetchImpl });
    await expect(
      client.filesUploadV2({ channel: "C1", filename: "note.txt", content: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow(HttpError);
  });
});
