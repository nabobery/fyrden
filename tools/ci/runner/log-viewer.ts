export interface ViewedRow {
  readonly i: number;
  readonly c: string;
}

/** Captures the small, whole rows used by the stock-runner masking probe. Never logs frames. */
export async function watchLog(url: string, token: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const rows: ViewedRow[] = [];
  const changed = new Set<() => void>();
  let error: Error | undefined;
  let closed = false;
  let frames = 0;
  let end: { log: string; durable: number } | undefined;
  let finish: (code: number | Error) => void = () => undefined;
  const finished = new Promise<number | Error>((resolve) => {
    finish = resolve;
  });
  const notify = () => {
    for (const check of changed) check();
  };
  const fail = (message: string) => {
    error ??= new Error(message);
    finish(error);
    notify();
    socket.close();
  };
  const deadline = AbortSignal.timeout(300_000);
  const expired = () => fail("The local log socket did not finish before its deadline.");
  deadline.addEventListener("abort", expired, { once: true });
  const cancelled = () => fail("The local log viewer setup was cancelled.");
  signal?.addEventListener("abort", cancelled, { once: true });
  socket.addEventListener("message", (event) => {
    frames++;
    try {
      const frame = JSON.parse(String(event.data)) as {
        t: string;
        rows?: ViewedRow[];
        log?: string;
        durable?: number;
      };
      if (frame.t === "end" && typeof frame.log === "string" && Number.isInteger(frame.durable)) {
        end = { log: frame.log, durable: frame.durable as number };
      } else if (frame.t === "rows" && Array.isArray(frame.rows) && frame.rows.length > 0) {
        for (const row of frame.rows) {
          if (row.i !== rows.length || typeof row.c !== "string")
            throw new Error("The local log socket skipped, repeated or malformed a row.");
          rows.push({ i: row.i, c: row.c });
        }
        socket.send(JSON.stringify({ t: "ack", i: rows.length, o: 0 }));
      } else {
        throw new Error("The masking probe received an unexpected log frame.");
      }
      notify();
    } catch {
      fail("The masking probe received a malformed or out-of-order log frame.");
    }
  });
  socket.addEventListener("error", () => fail("The local log socket failed."));
  socket.addEventListener("close", (event) => {
    closed = true;
    deadline.removeEventListener("abort", expired);
    signal?.removeEventListener("abort", cancelled);
    finish(event.code);
    notify();
  });
  const waitFor = (predicate: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (error || predicate() || closed) {
          changed.delete(check);
          if (error) reject(error);
          else if (predicate()) resolve();
          else reject(new Error("The local log socket closed before the expected rows arrived."));
        }
      };
      changed.add(check);
      check();
    });
  socket.addEventListener("open", notify);
  await waitFor(() => socket.readyState === WebSocket.OPEN);
  return {
    rows,
    waitForRows: (predicate: (rows: readonly ViewedRow[]) => boolean) =>
      waitFor(() => predicate(rows)),
    async completed() {
      const code = await finished;
      if (error) throw error;
      if (code instanceof Error) throw code;
      return { code, end, frames };
    },
    close: () => socket.close(),
  };
}
