// slack-socketmode.test.ts — no upstream Python module: SocketModeHandler is
// slack_bolt library code (see socketmode.ts's file header). These cases
// exercise the port against a fake WebSocket implementation, since no real
// Slack app-level token is available in this environment (PARITY.md).

import { describe, it, expect, vi } from "vitest";
import { SocketModeHandler } from "../src/slack/socketmode.ts";

type Listener = (ev: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
}

describe("slack socketmode", () => {
  it("acks an events_api envelope and dispatches its payload.event", async () => {
    FakeWebSocket.instances = [];
    const events: Array<Record<string, unknown>> = [];
    const handler = new SocketModeHandler({
      onEvent: (e) => events.push(e),
      openConnection: async () => "wss://fake/link",
      webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      log: () => {},
    });

    const startPromise = handler.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;

    ws.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: { event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "hi" } },
      }),
    });

    expect(events).toEqual([{ type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "hi" }]);
    expect(ws.sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);

    handler.stop();
    await startPromise;
  });

  it("a disconnect envelope closes the socket and reconnects", async () => {
    FakeWebSocket.instances = [];
    let opens = 0;
    const handler = new SocketModeHandler({
      onEvent: () => {},
      openConnection: async () => {
        opens += 1;
        return `wss://fake/link-${opens}`;
      },
      webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      log: () => {},
    });

    const startPromise = handler.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const first = FakeWebSocket.instances[0]!;
    first.emit("message", { data: JSON.stringify({ type: "disconnect", reason: "refresh_requested" }) });

    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    expect(first.closed).toBe(true);

    handler.stop();
    await startPromise;
  });

  it("stop() tears the current connection down and start() resolves", async () => {
    FakeWebSocket.instances = [];
    const handler = new SocketModeHandler({
      onEvent: () => {},
      openConnection: async () => "wss://fake/link",
      webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      log: () => {},
    });
    const startPromise = handler.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    handler.stop();
    await expect(startPromise).resolves.toBeUndefined();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  it("a malformed message is ignored, not thrown", async () => {
    FakeWebSocket.instances = [];
    const events: unknown[] = [];
    const handler = new SocketModeHandler({
      onEvent: (e) => events.push(e),
      openConnection: async () => "wss://fake/link",
      webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      log: () => {},
    });
    const startPromise = handler.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.instances[0]!;
    expect(() => ws.emit("message", { data: "not json" })).not.toThrow();
    expect(events).toEqual([]);
    handler.stop();
    await startPromise;
  });
});
