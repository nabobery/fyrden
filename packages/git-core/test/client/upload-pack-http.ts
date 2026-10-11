import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientResponse, HttpTransport } from "../../src/client/transport.js";
import { gitBinary } from "../../testing/git-cli.js";

/*
 * A tiny smart-HTTP server for client tests: it wraps git's own
 * `upload-pack --stateless-rpc` the way `git http-backend` does
 * (http-backend.c `get_info_refs` and `service_rpc`, git v2.53.0): the
 * `Git-Protocol` header becomes `GIT_PROTOCOL`, and the `# service=` header
 * line is written only for protocol v0.
 */

export interface UploadPackServer {
  /** The repository URL, `http://127.0.0.1:<port>/repo.git`. */
  readonly url: string;
  /** Request bodies the server received, in order (for assertions). */
  readonly requests: { method: string; path: string; body: Uint8Array }[];
  close(): Promise<void>;
}

export interface UploadPackServerOptions {
  /** Ignore `Git-Protocol` (an old server that only speaks v0). */
  readonly v0Only?: boolean;
  /** Answer every request with this status instead. */
  readonly status?: number;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function runUploadPack(
  repoDir: string,
  args: string[],
  protocol: string | undefined,
  input: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, ["upload-pack", ...args, repoDir], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: repoDir,
        ...(protocol ? { GIT_PROTOCOL: protocol } : {}),
      },
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(out)));
    child.stdin.end(input);
  });
}

export async function startUploadPackServer(
  repoDir: string,
  options: UploadPackServerOptions = {},
): Promise<UploadPackServer> {
  const requests: UploadPackServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, body });
      if (options.status !== undefined) {
        res.writeHead(options.status, { "Content-Type": "text/plain" }).end("nope\n");
        return;
      }
      const header = req.headers["git-protocol"];
      const protocol = options.v0Only || typeof header !== "string" ? undefined : header;
      const v2 = protocol?.includes("version=2") ?? false;
      if (req.method === "GET" && path === "/repo.git/info/refs?service=git-upload-pack") {
        const adv = await runUploadPack(
          repoDir,
          ["--stateless-rpc", "--advertise-refs"],
          protocol,
          new Uint8Array(0),
        );
        const prefix = v2 ? "" : "001e# service=git-upload-pack\n0000";
        res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
        res.end(Buffer.concat([Buffer.from(prefix), adv]));
        return;
      }
      if (req.method === "POST" && path === "/repo.git/git-upload-pack") {
        const out = await runUploadPack(repoDir, ["--stateless-rpc"], protocol, body);
        res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result" });
        // Several writes, so the client sees a chunked body.
        for (let at = 0; at < out.length; at += 7_000) res.write(out.subarray(at, at + 7_000));
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The client's transport over Node's fetch (test only; Workers use `guardedFetch`). */
export const nodeFetchTransport: HttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body } : {}),
    redirect: "manual",
  });
  return fromResponse(response);
};

export function fromResponse(response: Response): ClientResponse {
  const stream = response.body;
  return {
    status: response.status,
    contentType: response.headers.get("Content-Type"),
    body: {
      async *[Symbol.asyncIterator]() {
        if (!stream) return;
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    },
    cancel: async () => {
      await stream?.cancel().catch(() => {});
    },
  };
}
