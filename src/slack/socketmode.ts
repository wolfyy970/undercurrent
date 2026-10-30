// socketmode.ts — Slack Socket Mode transport.
// Best-effort, from-scratch replacement for `slack_bolt.adapter.socket_mode
// .SocketModeHandler`, which headlong_slack.cli wires up but does not itself
// implement (it is `slack_bolt`/`slack_sdk` library code, a real pip
// dependency the Python side pulls in — see pyproject.toml). Ported here
// because this port carries no runtime dependencies (Node's built-in
// `WebSocket`/`fetch` stand in, per the port's "no runtime deps" rule) —
// there is no Python module of `headlong_slack`'s own that this 1:1 ports.
//
// Protocol (per Slack's public Socket Mode docs, implemented from spec, not
// from slack_bolt's source): POST `apps.connections.open` with the
// app-level token (`xapp-...`) to mint a short-lived `wss://` URL, connect,
// and for every `{"envelope_id": ..., "type": "events_api", "payload":
// {"event": {...}}}` message received, hand `payload.event` to `onEvent` and
// ack by sending `{"envelope_id": ...}` back on the same socket — Slack
// redelivers an envelope that goes unacked for ~3s. A `{"type":
// "disconnect"}` message means the server is about to close this socket;
// open a new connection before it does. Interactivity/slash-command envelope
// types are not handled — headlong_slack.cli never enables them
// (`slack.json`'s manifest sets `interactivity.is_enabled: false`).
//
// PORT-NOTE / KNOWN GAP: no real Slack app-level token is available in this
// environment (see PARITY.md), so this module has never made a real
// `apps.connections.open` call or held a real Socket Mode connection. It is
// implemented from the public protocol description, not verified against
// live traffic or against slack_bolt's own reconnect/ping timing, which is
// not published as a stable contract. Treat the reconnect-on-disconnect path
// especially as unverified.

export interface SocketModeOptions {
  onEvent: (event: Record<string, unknown>) => void;
  log?: (line: string) => void;
  /** Mints a fresh wss:// URL; normally `WebClient(appToken).appsConnectionsOpen`. */
  openConnection: () => Promise<string>;
  /** Injectable for tests; defaults to the global `WebSocket`. */
  webSocketImpl?: new (url: string) => WebSocket;
}

interface Envelope {
  envelope_id?: string;
  type?: string;
  payload?: { event?: Record<string, unknown> };
  reason?: string;
}

export class SocketModeHandler {
  private readonly opts: SocketModeOptions;
  private readonly log: (line: string) => void;
  private ws: WebSocket | null = null;
  private stopped = false;

  constructor(opts: SocketModeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** Connects and stays connected (reconnecting as directed by the server)
   *  until `stop()` is called. Resolves once `stop()` has torn the socket
   *  down — mirrors `SocketModeHandler.start()` blocking the caller. */
  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      await this.connectOnce();
    }
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve) => {
      this.opts
        .openConnection()
        .then((url) => {
          if (this.stopped) {
            resolve();
            return;
          }
          const Impl = this.opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (!Impl) throw new Error("no WebSocket implementation available");
          const ws = new Impl(url);
          this.ws = ws;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          ws.addEventListener("message", (ev: MessageEvent) => {
            let envelope: Envelope;
            try {
              envelope = JSON.parse(String(ev.data)) as Envelope;
            } catch {
              return;
            }
            if (envelope.type === "disconnect") {
              this.log(`socket mode: server requested disconnect (${envelope.reason ?? "?"})`);
              ws.close();
              return;
            }
            if (envelope.envelope_id) {
              try {
                ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
              } catch (err) {
                this.log(`socket mode: ack failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            const event = envelope.payload?.event;
            if (envelope.type === "events_api" && event) {
              try {
                this.opts.onEvent(event);
              } catch (err) {
                this.log(`socket mode: onEvent handler threw: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          });
          ws.addEventListener("close", () => finish());
          ws.addEventListener("error", (ev: Event) => {
            this.log(`socket mode: connection error: ${String(ev)}`);
          });
        })
        .catch((err: unknown) => {
          this.log(`socket mode: connect failed: ${err instanceof Error ? err.message : String(err)}`);
          resolve();
        });
    });
  }
}
