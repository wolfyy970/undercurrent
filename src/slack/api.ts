// api.ts — thin fetch client for the Slack Web API.
// Faithful port of the slice of `slack_bolt`/`slack_sdk`'s `WebClient` the
// Python bridge actually calls: `auth_test`, `users_info`,
// `conversations_info`, `chat_postMessage`, plus `apps_connections_open`
// (used by Socket Mode itself, see socketmode.ts). headlong_slack has no
// api.py of its own — it is a pure client of `slack_bolt`'s `App`/`WebClient`
// — so this module is this port's from-scratch replacement for that
// dependency (kept dependency-free per the port's "no runtime deps" rule),
// the same relationship src/telegram/api.ts has to the hand-rolled
// `headlong_telegram.api` module it ports directly.
//
// Wire shape (read directly from the installed slack_sdk source —
// `slack_sdk.web.base_client.BaseClient._perform_urllib_http_request` /
// `_build_urllib_request_headers` — not assumed): always POST to
// `https://slack.com/api/<method>`, `Authorization: Bearer <token>`. Which
// methods send JSON vs form-encoded is NOT uniform: `chat.postMessage` (and
// any call with `blocks`/`attachments`) goes through WebClient's `json=`
// path — `Content-Type: application/json;charset=utf-8`, a JSON body — while
// `auth.test`/`users.info`/`conversations.info` go through the `params=`
// path — `Content-Type: application/x-www-form-urlencoded`, urlencoded body
// (slack_sdk sends these as POST regardless of the `http_verb="GET"` the
// wrapper methods pass; see `_perform_urllib_http_request`'s own comment,
// "you can use POST method for all the Web APIs"). Every response is
// `{ok: true, ...}` or `{ok: false, error: "..."}`; `SlackApiError` carries
// the latter. A transport failure (DNS, connection refused, timeout) is
// `HttpError` — the Python bridge does not distinguish the two (broad
// `except Exception` throughout), so both extend one `SlackError` here for
// callers that don't care, mirroring that breadth.

export class SlackError extends Error {}

/** A well-formed `{ok: false, error: "..."}` Slack response. */
export class SlackApiError extends SlackError {
  /** The parsed `{ok:false, error}` body (slack_sdk's SlackApiError.response);
   *  outbound reads `.error` for a delivery notice's reason. PORT-NOTE (2e39a3f). */
  response?: Record<string, unknown>;
  constructor(message: string, response?: Record<string, unknown>) {
    super(message);
    if (response !== undefined) this.response = response;
  }
}

/** Network/transport-level failure (connect, DNS, abort/timeout). */
export class HttpError extends SlackError {}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

export class WebClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    token: string,
    opts: { baseUrl?: string; timeoutMs?: number; fetchImpl?: FetchLike } = {},
  ) {
    this.token = token;
    this.base = opts.baseUrl ?? "https://slack.com/api";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async send(method: string, init: { headers: Record<string, string>; body: string }): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new HttpError(`${method}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SlackApiError(`${method}: non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new SlackApiError(`${method}: unexpected response shape`);
    }
    const obj = payload as Record<string, unknown>;
    if (!obj.ok) {
      throw new SlackApiError(`${method}: ${obj.error ?? text}`, obj);
    }
    return obj;
  }

  /** `params=` methods (auth.test, users.info, conversations.info): form-
   *  urlencoded body, `undefined`/`null` values dropped. PORT-NOTE (1c:
   *  d5cc776, found while proving `conversations.replies` parity): booleans
   *  are converted to "0"/"1", not "true"/"false" — read directly from
   *  slack_sdk's `internal_utils.convert_bool_to_0_or_1`/`_to_0_or_1_if_bool`,
   *  which every `params=` wrapper method runs its kwargs through
   *  ("Slack APIs safely accept 0/1 as boolean values... True/False doesn't
   *  work with aiohttp"). This conversion is `params=`-only — `callJson`
   *  below keeps real JSON booleans, matching `chat.postMessage`'s
   *  `unfurl_links`. */
  private async callForm(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    return this.send(method, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }

  /** `json=` methods (chat.postMessage): JSON body, `undefined` values
   *  dropped (matching slack_sdk's `_remove_none_values`), booleans kept as
   *  JSON booleans (NOT converted to "1"/"0" — that conversion only applies
   *  to the form-encoded `params=`/`data=` path, not `json=`). */
  private async callJson(method: string, json: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      if (v !== undefined) body[k] = v;
    }
    return this.send(method, {
      headers: { "content-type": "application/json;charset=utf-8" },
      body: JSON.stringify(body),
    });
  }

  async authTest(): Promise<Record<string, unknown>> {
    return this.callForm("auth.test");
  }

  async usersInfo(user: string): Promise<Record<string, unknown>> {
    const res = await this.callForm("users.info", { user });
    return res.user as Record<string, unknown>;
  }

  async conversationsInfo(channel: string): Promise<Record<string, unknown>> {
    const res = await this.callForm("conversations.info", { channel });
    return res.channel as Record<string, unknown>;
  }

  async chatPostMessage(
    channel: string,
    text: string,
    opts: { threadTs?: string | null; unfurlLinks?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { channel, text };
    if (opts.threadTs != null) params.thread_ts = opts.threadTs;
    if (opts.unfurlLinks !== undefined) params.unfurl_links = opts.unfurlLinks;
    // PORT-NOTE (2e39a3f): returns the response (outbound reads its `ts` for
    // the delivery notice); it used to be discarded.
    return this.callJson("chat.postMessage", params);
  }

  /** `conversations.open` — slack_sdk's `conversations_open(users=...)` goes
   *  through the `params=` (form) path; a single user id is sent as-is, a
   *  list is comma-joined by slack_sdk. PORT-NOTE (2e39a3f: bare slack-U… DMs). */
  async conversationsOpen(users: string): Promise<Record<string, unknown>> {
    return this.callForm("conversations.open", { users });
  }

  /** PORT-NOTE (1c: f68c1d8): `chat.getPermalink` — read directly from the
   *  installed slack_sdk source (`web/client.py`'s `chat_getPermalink`):
   *  `params=` (form) path like `users.info`/`reactions.get`, http_verb
   *  "GET" but still a real POST per slack_sdk's own request helper. */
  async chatGetPermalink(channel: string, messageTs: string): Promise<Record<string, unknown>> {
    return this.callForm("chat.getPermalink", { channel, message_ts: messageTs });
  }

  /** Socket Mode's own bootstrap call: mints a short-lived WSS URL. Uses the
   *  app-level token (`xapp-...`), not the bot token — callers pass a
   *  WebClient constructed with that token. */
  async appsConnectionsOpen(): Promise<string> {
    const res = await this.callForm("apps.connections.open");
    return res.url as string;
  }

  /** PORT-NOTE (1c: ed0b700, d5cc776): `reactions.get` and
   *  `conversations.replies` — read directly from the installed slack_sdk
   *  source (`web/client.py`'s `reactions_get`/`conversations_replies`) —
   *  both go through the `params=` (form) path like `users.info`, not
   *  `json=`; neither passes `blocks`/`attachments`. */
  async reactionsGet(channel: string, timestamp: string): Promise<Record<string, unknown>> {
    return this.callForm("reactions.get", { channel, timestamp });
  }

  async conversationsReplies(params: {
    channel: string;
    ts: string;
    latest?: string;
    inclusive?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    return this.callForm("conversations.replies", params);
  }

  /** PORT-NOTE (1c: 6a98ab5): `reactions.add`, same `params=` wire shape as
   *  `reactions.get` (read from the same slack_sdk source). */
  async reactionsAdd(channel: string, timestamp: string, name: string): Promise<void> {
    await this.callForm("reactions.add", { channel, timestamp, name });
  }

  /**
   * PORT-NOTE (1c: 692e16e): `files.upload_v2` is not a single Web API call
   * — slack_sdk's `WebClient.files_upload_v2` (read directly from
   * `web/client.py` / `web/internal_utils.py` / `web/base_client.py`, not
   * assumed) is a 3-step client-side helper with no 1:1 server endpoint:
   *   1. `files.getUploadURLExternal` (`params=` form, {filename, length}) ->
   *      {file_id, upload_url}
   *   2. a raw `POST <upload_url>` of the file bytes — NOT under
   *      `slack.com/api/`, no Authorization header, no JSON envelope
   *      (`_upload_file_via_v2_url`: `Request(method="POST", url=url,
   *      data=data, headers={})`) — just the pre-signed one-time URL Slack
   *      handed back in step 1.
   *   3. `files.completeUploadExternal` (`params=` form, `files` as a
   *      JSON-stringified `[{id, title}]` array, plus `channel_id`,
   *      `thread_ts`, `initial_comment`).
   * Ported as all three real calls, in this order, so a differential proof
   * against the fake server sees the exact same request sequence.
   */
  async filesUploadV2(opts: {
    channel: string;
    filename: string;
    title?: string;
    content: Uint8Array;
    threadTs?: string | null;
    initialComment?: string | null;
  }): Promise<Record<string, unknown>> {
    const urlRes = await this.callForm("files.getUploadURLExternal", {
      filename: opts.filename,
      length: opts.content.length,
    });
    const uploadUrl = String(urlRes.upload_url ?? "");
    const fileId = String(urlRes.file_id ?? "");
    let uploadResp: Response;
    try {
      uploadResp = await this.fetchImpl(uploadUrl, {
        method: "POST",
        headers: {},
        body: opts.content,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new HttpError(`files.upload_v2 (upload step): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!uploadResp.ok) {
      throw new HttpError(`files.upload_v2: upload step failed (HTTP ${uploadResp.status})`);
    }
    const files = [{ id: fileId, title: opts.title ?? opts.filename }];
    return this.callForm("files.completeUploadExternal", {
      files: JSON.stringify(files),
      channel_id: opts.channel,
      thread_ts: opts.threadTs ?? undefined,
      initial_comment: opts.initialComment ?? undefined,
    });
  }
}
