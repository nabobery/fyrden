import { env } from "cloudflare:workers";
import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { createLogger, createMetrics } from "@fyrden/adapters-cloudflare/obs";
import { AUTHENTICATED, defineOperation, INSTANCE_ADMIN } from "@fyrden/api-contract";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  executeOperation,
  type Handlers,
  type OpContext,
  OperationError,
} from "../src/ops/execute.js";
import { handlers } from "../src/ops/handlers.js";

const writeOp = defineOperation({
  id: "test.write",
  method: "POST",
  path: "/test",
  summary: "A write",
  input: z.object({ value: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: AUTHENTICATED,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

const record = { id: "tok_1", principalType: "user" } as TokenRecord;

function ctx(mode: "read" | "write", fresh: boolean): OpContext {
  return {
    env,
    auth: record,
    authState: {
      record,
      mode,
      verifyForWrite: vi.fn(async () =>
        fresh ? { ok: true as const, record } : { ok: false as const, reason: "revoked" as const },
      ),
    },
    log: createLogger({}, () => {}),
    metrics: createMetrics({ writeDataPoint: () => {} }),
    requestId: "req-exec",
    waitUntil: () => {},
  };
}

describe("Handlers (checked by tsc)", () => {
  it("requires a handler for every registry operation, with its own types", () => {
    // @ts-expect-error meta.whoami has no handler
    const missing: Handlers = {};
    const wrongOutput: Handlers = {
      // @ts-expect-error the output does not match meta.whoami's schema
      "meta.whoami": async () => ({ id: 1 }),
    };
    const extra: Handlers = {
      ...handlers,
      // @ts-expect-error no registry operation has this id
      "meta.unknown": async () => ({}),
    };
    expect([missing, wrongOutput, extra]).toHaveLength(3);
  });
});

describe("executeOperation", () => {
  it.each([
    ["an unknown permission, for anyone (fails closed)", "repo:write", true],
    ["instance:admin, for a non-admin", INSTANCE_ADMIN, false],
  ])("denies %s", async (_, permission, admin) => {
    const op = { ...writeOp, permission };
    const handler = vi.fn(async () => ({ ok: true }));
    const c: OpContext = {
      ...ctx("write", true),
      auth: { ...record, isInstanceAdmin: admin } as TokenRecord,
    };
    const result = await executeOperation(op, handler, c, { value: "x" });
    expect(result).toMatchObject({
      ok: false,
      problem: { status: 403, code: "missing_permission", missing_permission: permission },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks instance:admin against the re-verified record, not the cached one", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const cached = { ...record, isInstanceAdmin: true } as TokenRecord;
    const demoted = { ...record, isInstanceAdmin: false } as TokenRecord;
    const c: OpContext = {
      ...ctx("read", true),
      auth: cached,
      authState: {
        record: cached,
        mode: "read",
        verifyForWrite: async () => ({ ok: true as const, record: demoted }),
      },
    };
    const result = await executeOperation({ ...writeOp, permission: INSTANCE_ADMIN }, handler, c, {
      value: "x",
    });
    expect(result).toMatchObject({
      ok: false,
      problem: { status: 403, code: "missing_permission" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("turns an OperationError from a handler into its problem, and rethrows anything else", async () => {
    const c = ctx("write", true);
    const conflict = await executeOperation(
      writeOp,
      async () => {
        throw new OperationError(409, "handle_taken", "taken");
      },
      c,
      { value: "x" },
    );
    expect(conflict).toMatchObject({ ok: false, problem: { status: 409, code: "handle_taken" } });
    await expect(
      executeOperation(
        writeOp,
        async () => {
          throw new Error("bug");
        },
        c,
        { value: "x" },
      ),
    ).rejects.toThrow("bug");
  });

  it("re-verifies on the D1 primary before a write on a read-verified request", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const c = ctx("read", false);
    const result = await executeOperation(writeOp, handler, c, { value: "x" });
    expect(result).toMatchObject({ ok: false, problem: { status: 401, code: "invalid_token" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands the handler the record the primary returned, not the cached one", async () => {
    const cached = { ...record, isInstanceAdmin: true, scopes: ["admin"] } as TokenRecord;
    const fresh = { ...record, isInstanceAdmin: false, scopes: [] } as TokenRecord;
    const c: OpContext = {
      ...ctx("read", true),
      auth: cached,
      authState: {
        record: cached,
        mode: "read",
        verifyForWrite: async () => ({ ok: true as const, record: fresh }),
      },
    };
    const seen: TokenRecord[] = [];
    const result = await executeOperation(
      writeOp,
      async (handlerCtx) => {
        seen.push(handlerCtx.auth, handlerCtx.authState.record);
        return { ok: true };
      },
      c,
      { value: "x" },
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([fresh, fresh]);
  });

  it("checks the principal type against the re-verified record", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const agent = { ...record, principalType: "agent" } as TokenRecord;
    const c: OpContext = {
      ...ctx("read", true),
      authState: {
        record,
        mode: "read",
        verifyForWrite: async () => ({ ok: true as const, record: agent }),
      },
    };
    const result = await executeOperation(writeOp, handler, c, { value: "x" });
    expect(result).toMatchObject({ ok: false, problem: { status: 403 } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not re-verify a request already verified for writing", async () => {
    const c = ctx("write", false);
    const result = await executeOperation(writeOp, async () => ({ ok: true }), c, { value: "x" });
    expect(result).toEqual({ ok: true, output: { ok: true } });
    expect(c.authState.verifyForWrite).not.toHaveBeenCalled();
  });

  it("rejects a principal type the operation does not allow, before the handler", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const c = { ...ctx("write", true), auth: { ...record, principalType: "agent" } as TokenRecord };
    const result = await executeOperation(writeOp, handler, c, { value: "x" });
    expect(result).toMatchObject({ ok: false, problem: { status: 403 } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns a 422 problem for invalid input", async () => {
    const result = await executeOperation(writeOp, async () => ({ ok: true }), ctx("write", true), {
      value: 1,
    });
    expect(result).toMatchObject({
      ok: false,
      problem: { status: 422, code: "invalid_input", request_id: "req-exec" },
    });
  });
});
