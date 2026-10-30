// api.ts — thin fetch client for the Telegram Bot API.
// Faithful port of headlong_telegram.api (Python, which uses httpx).
//
// Only the handful of methods the bridge needs. Every call returns the
// `result` payload on ok=true and raises ApiError otherwise, except
// getUpdates, which lets a 409 (another poller holds the token) surface as
// ApiError too.
//
// PORT-NOTE: Python's httpx.HTTPError (connection refused, DNS failure, a
// client-side timeout) has no TS built-in analogue — `fetch` throws a plain
// error for all of those. HttpError is that TS-side signal; the poll loop
// (inbound.ts) catches both ApiError and HttpError, exactly as the Python
// poll loop catches `(ApiError, httpx.HTTPError)`.

// Long-poll wait for getUpdates; the request timeout must comfortably exceed it.
export const POLL_SECONDS = 50;

// Matches httpx.Timeout(30, read=POLL_SECONDS + 10): every call on the shared
// client gets this timeout (not just getUpdates).
const DEFAULT_TIMEOUT_MS = (POLL_SECONDS + 10) * 1000;

export class ApiError extends Error {}

/** Network/transport-level failure (connect, DNS, abort/timeout) — the TS
 *  analogue of httpx.HTTPError. Never a well-formed-but-bad Telegram reply;
 *  see ApiError for that. */
export class HttpError extends Error {}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class Bot {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(token: string, opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {}) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async call(
    method: string,
    params: Record<string, unknown> = {},
    files?: Record<string, { filename: string; bytes: Buffer }>,
  ): Promise<unknown> {
    let init: RequestInit;
    if (files) {
      // PORT-NOTE (1c: 06f1588): Python's `_call` posts `data=params,
      // files=files` (multipart/form-data) when files are given, `json=params`
      // otherwise. Node's fetch picks multipart automatically for a
      // FormData body, so no explicit content-type header is set here.
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        form.append(k, String(v));
      }
      for (const [field, f] of Object.entries(files)) {
        form.append(field, new Blob([f.bytes]), f.filename);
      }
      init = { method: "POST", body: form, signal: AbortSignal.timeout(this.timeoutMs) };
    } else {
      init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      };
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/${method}`, init);
    } catch (err) {
      throw new HttpError(`${method}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Anything that is not a well-formed Telegram envelope has to leave here
    // as ApiError. The poll loop retries on (ApiError, HttpError) and dies on
    // everything else, so a 502 HTML page from an edge would otherwise raise
    // a JSON parse error straight through it. The response text is truncated
    // and the URL left out because the URL carries the token.
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(`${method}: non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ApiError(`${method}: unexpected response shape`);
    }
    const obj = payload as Record<string, unknown>;
    if (!obj.ok) {
      throw new ApiError(`${method}: ${obj.description ?? text}`);
    }
    if (!("result" in obj)) {
      throw new ApiError(`${method}: ok response carried no result`);
    }
    return obj.result;
  }

  async getMe(): Promise<Record<string, unknown>> {
    return (await this.call("getMe")) as Record<string, unknown>;
  }

  async getUpdates(offset: number): Promise<Array<Record<string, unknown>>> {
    return (await this.call("getUpdates", {
      offset,
      timeout: POLL_SECONDS,
      allowed_updates: ["message"],
    })) as Array<Record<string, unknown>>;
  }

  async sendMessage(chatId: number, text: string, html = false): Promise<void> {
    const params: Record<string, unknown> = { chat_id: chatId, text };
    if (html) params.parse_mode = "HTML";
    await this.call("sendMessage", params);
  }

  async leaveChat(chatId: number): Promise<void> {
    await this.call("leaveChat", { chat_id: chatId });
  }

  // PORT-NOTE (1c: 06f1588): send_document/send_photo upload the decoded
  // file bytes via multipart/form-data rather than stuffing them into
  // sendMessage's `text` field. `content` may be a Buffer (binary files,
  // decoded from content_b64) or a string (text files); Python's
  // `if isinstance(content, str): content = content.encode("utf-8")`
  // matches Buffer.from(content, "utf8") here.
  async sendDocument(
    chatId: number,
    content: Buffer | string,
    filename: string,
    caption?: string | null,
  ): Promise<unknown> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const params: Record<string, unknown> = { chat_id: chatId };
    if (caption) params.caption = caption;
    return this.call("sendDocument", params, { document: { filename, bytes } });
  }

  async sendPhoto(
    chatId: number,
    content: Buffer | string,
    filename: string,
    caption?: string | null,
  ): Promise<unknown> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const params: Record<string, unknown> = { chat_id: chatId };
    if (caption) params.caption = caption;
    return this.call("sendPhoto", params, { photo: { filename, bytes } });
  }
}
