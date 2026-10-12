import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createApp } from "../../src/app.js";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { basic, createRepo, ORIGIN, type TestRepo } from "./git-http.js";
import { principalWithToken } from "./principals.js";
import { reportLines } from "./push-fixtures.js";
import { signal } from "./repo-git.js";

export const RECEIVE = "git-receive-pack";

export interface PushTarget {
  readonly repo: TestRepo;
  readonly owner: { principalId: string; token: string };
  /** `/<owner>/<repo>.git` */
  readonly path: string;
}

/** A new repository owned by a new user with a git token. */
export async function pushTarget(): Promise<PushTarget> {
  const owner = await principalWithToken("user", "git");
  const repo = await createRepo(owner.principalId);
  const handle = owner.principalId.toLowerCase().replace("_", "-");
  return { repo, owner, path: `/${handle}/${repo.name}.git` };
}

export interface PushReply {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  readonly report: string[];
  readonly progress: string[];
}

/**
 * POSTs a receive-pack body through the Worker, with optional Worker
 * variables (push tuning) set for this request only.
 */
export async function postPush(
  target: PushTarget,
  body: Uint8Array,
  options: {
    vars?: Record<string, string>;
    token?: string;
    headers?: Record<string, string>;
    /** Sent as a stream without a length (git's chunked requests). */
    chunked?: boolean;
    /** Bindings to replace for this request (e.g. `holdAfterRunPush`'s `REPO`). */
    bindings?: Partial<Env>;
  } = {},
): Promise<PushReply> {
  const ctx = createExecutionContext();
  const stream = options.chunked
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < body.length; at += 4096)
            controller.enqueue(body.slice(at, at + 4096));
          controller.close();
        },
      })
    : body;
  const request = new Request(`${ORIGIN}${target.path}/${RECEIVE}`, {
    method: "POST",
    headers: {
      "Content-Type": `application/x-${RECEIVE}-request`,
      Authorization: basic(options.token ?? target.owner.token),
      // What an HTTP client sends with a body of known length (a Request
      // made here does not get the header by itself).
      ...(options.chunked ? {} : { "Content-Length": String(body.length) }),
      ...options.headers,
    },
    body: stream,
    ...(options.chunked ? { duplex: "half" } : {}),
  } as RequestInit);
  const response = await createApp().fetch(
    request,
    { ...env, ...options.vars, ...options.bindings },
    ctx,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  const lines = response.status === 200 ? reportLines(bytes) : { report: [], progress: [] };
  return {
    status: response.status,
    contentType: response.headers.get("Content-Type"),
    bytes,
    ...lines,
  };
}

/**
 * A `REPO` binding whose stubs hold the Worker's push after `runPush`
 * answers (the upload is accepted and indexing has started) until the test
 * calls `resume`: the test acts between acceptance and the Worker's
 * re-authorization at a point it controls, instead of racing the indexing.
 */
export function holdAfterRunPush(): {
  REPO: Env["REPO"];
  accepted: () => Promise<void>;
  resume: () => void;
} {
  const accepted = signal();
  const resumed = signal();
  const holdStub = (stub: DurableObjectStub<RepoDO>) =>
    new Proxy(stub, {
      get(target, property) {
        if (property === "runPush")
          return async (...args: Parameters<RepoDO["runPush"]>) => {
            const progress = await target.runPush(...args);
            accepted.open();
            await resumed.wait();
            return progress;
          };
        // An RPC stub answers any property, `bind` included, as a remote method.
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]) => Reflect.apply(value, target, args)
          : value;
      },
    });
  const REPO = new Proxy(env.REPO, {
    get(target, property) {
      if (property === "getByName") return (name: string) => holdStub(target.getByName(name));
      const value = (target as unknown as Record<PropertyKey, unknown>)[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { REPO, accepted: () => accepted.wait(), resume: resumed.open };
}
