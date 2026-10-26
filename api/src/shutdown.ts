export interface ClosableServer {
  /** 新規接続の受付を止め、進行中のリクエストが終わったら cb を呼ぶ(node:http の Server.close と同じ契約) */
  close(cb: () => void): void;
}

export interface ClosableGateway {
  close(): Promise<void>;
}

export interface ShutdownOptions {
  timeoutMs: number;
  exit: (code: number) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * 終了処理。順序が重要:
 * 1. server.close() で新規接続の受付を止める(完了は待たない)
 * 2. gateway.close() で待ち受け中の応答待ちを即時に却下する。これにより進行中の
 *    HTTP リクエストは 503 で返り、電球のタイムアウトまで待たずに済む
 * 3. server.close() の完了(進行中リクエストの終了)を待つ
 * timeoutMs を超えたら exit(1) で強制終了する。
 */
export async function gracefulShutdown(
  server: ClosableServer,
  gateway: ClosableGateway,
  options: ShutdownOptions,
): Promise<void> {
  const forceExit = setTimeout(() => {
    options.error("shutdown timed out");
    options.exit(1);
  }, options.timeoutMs);

  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.close();
  await serverClosed;

  clearTimeout(forceExit);
  options.log("shutdown complete");
  options.exit(0);
}
