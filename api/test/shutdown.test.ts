import { describe, it, expect, vi } from "vitest";
import { gracefulShutdown, type ClosableServer } from "../src/shutdown.js";

/** 進行中リクエストが終わるまで close が完了しない HTTP サーバーの模倣 */
class FakeServer implements ClosableServer {
  pending = 0;
  private onClosed: (() => void) | null = null;
  close(cb: () => void): void {
    this.onClosed = cb;
    this.tryFinish();
  }
  requestDone(): void {
    this.pending -= 1;
    this.tryFinish();
  }
  private tryFinish(): void {
    if (this.pending === 0 && this.onClosed) {
      const cb = this.onClosed;
      this.onClosed = null;
      cb();
    }
  }
}

class FakeGateway {
  closed = false;
  onClose: () => void = () => {};
  async close(): Promise<void> {
    this.closed = true;
    this.onClose();
  }
}

function exitRecorder() {
  let resolve: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => (resolve = r));
  const exit = vi.fn((code: number) => resolve(code));
  return { exit, exited };
}

describe("gracefulShutdown", () => {
  it("closes the gateway before waiting for in-flight requests, so pending waiters are released", async () => {
    const server = new FakeServer();
    server.pending = 1;
    const gateway = new FakeGateway();
    // 進行中リクエストはゲートウェイの close(待ち受けの却下)で初めて応答できる
    gateway.onClose = () => server.requestDone();
    const { exit, exited } = exitRecorder();

    void gracefulShutdown(server, gateway, { timeoutMs: 300, exit, log: () => {}, error: () => {} });

    expect(await exited).toBe(0);
    expect(gateway.closed).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("force-exits with 1 when shutdown exceeds the timeout", async () => {
    const server = new FakeServer();
    server.pending = 1; // 誰も終わらせない
    const gateway = new FakeGateway();
    const error = vi.fn();
    const { exit, exited } = exitRecorder();

    void gracefulShutdown(server, gateway, { timeoutMs: 50, exit, log: () => {}, error });

    expect(await exited).toBe(1);
    expect(error).toHaveBeenCalledWith("shutdown timed out");
  });
});
