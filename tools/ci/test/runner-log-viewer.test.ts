import { afterEach, describe, expect, it, vi } from "vitest";
import { watchLog } from "../runner/log-viewer.js";

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static readonly instances: Socket[] = [];
  readyState = 0;
  closes = 0;

  constructor() {
    super();
    Socket.instances.push(this);
  }

  open() {
    this.readyState = Socket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.closes++;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  Socket.instances.length = 0;
});

describe("the stock-runner log viewer's setup lifetime", () => {
  it("does not open a socket after setup was cancelled", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const controller = new AbortController();
    controller.abort();
    await expect(watchLog("ws://localhost/logs", "fixture", controller.signal)).rejects.toThrow();
    expect(Socket.instances.length).toBe(0);
  });

  it("closes a socket and releases setup when cancelled during its upgrade", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const controller = new AbortController();
    const pending = watchLog("ws://localhost/logs", "fixture", controller.signal);
    const socket = Socket.instances[0];
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(socket?.closes).toBe(1);
  });

  it("cancels a row wait and closes a socket already acquired by setup", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const controller = new AbortController();
    const opening = watchLog("ws://localhost/logs", "fixture", controller.signal);
    const socket = Socket.instances[0];
    socket?.open();
    const viewer = await opening;
    const pending = viewer.waitForRows((rows) => rows.length > 0);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await expect(viewer.completed()).rejects.toThrow(/cancelled/);
    expect(socket?.closes).toBe(1);
  });
  it("settles completion on failure even when the peer never closes", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const controller = new AbortController();
    const opening = watchLog("ws://localhost/logs", "fixture", controller.signal);
    const socket = Socket.instances[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    const viewer = await opening;
    vi.spyOn(socket, "close").mockImplementation(() => {
      socket.closes++;
    });
    let completedError: unknown;
    const completed = viewer.completed().catch((error: unknown) => {
      completedError = error;
    });
    const rows = viewer.waitForRows((rows) => rows.length > 0);
    try {
      controller.abort();
      await expect(rows).rejects.toThrow(/cancelled/);
      await Promise.resolve();
      expect(completedError).toBeInstanceOf(Error);
    } finally {
      socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
      await completed;
    }
  });
});
