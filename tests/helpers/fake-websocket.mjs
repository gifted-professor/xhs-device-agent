export class FakeWebSocket {
  constructor(url, scenario = null) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();

    if (scenario) {
      queueMicrotask(() => scenario(this));
    }
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(payload) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", { data });
  }

  malformed(data = "{not-json") {
    this.emit("message", { data });
  }

  error(error = new Error("fake websocket error")) {
    this.emit("error", { error });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

export function createFakeWebSocketFactory(scenarios = []) {
  const pending = [...scenarios];
  const sockets = [];

  class ScenarioWebSocket extends FakeWebSocket {
    constructor(url) {
      super(url, pending.shift() || null);
      sockets.push(this);
    }
  }

  return { WebSocket: ScenarioWebSocket, sockets };
}
