import type {
  getReadModelExport,
  getReadModelExportPage,
  handshakeReadModel,
  Input,
  Output,
  pauseReadModel,
  resumeReadModel,
} from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import {
  EXPORT_TABLES,
  type ExportCursor,
  ExportFenceLost,
  exportAvailability,
  exportManifest,
  exportPage,
} from "./export.js";
import {
  pauseReadModel as pause,
  ReadModelRecovering,
  readModelState,
  resumeReadModel as resume,
} from "./maintenance.js";
import { handshake } from "./restore-token.js";

/*
 * The read model's maintenance as instance administrators run it through
 * the API (its one shard): the pause and resume steps, and a coherent
 * export of it under a pause's generation.
 */

/** The `admin.read_model.pause` operation: one step of the pause. */
export async function pauseReadModelOperation(
  ctx: OpContext,
  _input: Input<typeof pauseReadModel>,
): Promise<Output<typeof pauseReadModel>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "read_model_pause" });
  try {
    return await pause(ctx.env, DEFAULT_ORG_SHARD);
  } catch (error) {
    if (error instanceof ReadModelRecovering)
      throw new OperationError(409, "read_model_recovering", "The read model is being recovered.");
    throw error;
  }
}

/** The `admin.read_model.resume` operation. */
export async function resumeReadModelOperation(
  ctx: OpContext,
  input: Input<typeof resumeReadModel>,
): Promise<Output<typeof resumeReadModel>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "read_model_resume" });
  return resume(ctx.env, DEFAULT_ORG_SHARD, input.generation);
}

/** The `admin.read_model.handshake` operation: a handshake of the restore token. */
export async function handshakeReadModelOperation(
  ctx: OpContext,
  _input: Input<typeof handshakeReadModel>,
): Promise<Output<typeof handshakeReadModel>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "read_model_handshake" }, 3);
  ctx.metrics.count("d1.query", { db: "org", op: "read_model_handshake" }, 3);
  if ((await handshake(ctx.env, DEFAULT_ORG_SHARD)) === "mismatch")
    throw new OperationError(
      409,
      "restore_token_mismatch",
      "The read model holds a restore token the directory does not know: it was restored, or changed, since the last handshake. Recover it before anything writes it again.",
    );
  return { restore_token: "matched" };
}

/** Refused unless a restore floor is recorded. */
async function exportable(ctx: OpContext): Promise<void> {
  ctx.metrics.count("d1.query", { db: "directory", op: "read_model_status" }, 2);
  ctx.metrics.count("d1.query", { db: "org", op: "read_model_status" }, 2);
  const { directory } = await readModelState(ctx.env, DEFAULT_ORG_SHARD);
  if (!exportAvailability(directory?.floor ?? null).available)
    throw new OperationError(
      409,
      "no_restore_floor",
      "No restore floor is recorded yet: deploy with `fyrden deploy` to record one.",
    );
}

/** An export's step under a moved barrier: the export starts over. */
async function fenced<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExportFenceLost)
      throw new OperationError(
        409,
        "export_fence_lost",
        "The read model is no longer paused at this generation: pause it and start over.",
      );
    throw error;
  }
}

/** The `admin.read_model.export` operation: the export's manifest. */
export async function getReadModelExportOperation(
  ctx: OpContext,
  input: Input<typeof getReadModelExport>,
): Promise<Output<typeof getReadModelExport>> {
  await exportable(ctx);
  ctx.metrics.count("d1.query", { db: "org", op: "read_model_export" });
  const manifest = await fenced(() =>
    exportManifest(readModelFor(ctx.env, DEFAULT_ORG_SHARD), input.generation),
  );
  return {
    ...manifest,
    derived: [...manifest.derived],
    migrations: [...manifest.migrations],
    tables: manifest.tables.map((t) => ({ table: t.table, columns: [...t.columns] })),
    protocol: Object.fromEntries(Object.entries(manifest.protocol).map(([k, v]) => [k, [...v]])),
  };
}

/** The `admin.read_model.export_page` operation: a page, and the cursor of the next. */
export async function getReadModelExportPageOperation(
  ctx: OpContext,
  input: Input<typeof getReadModelExportPage>,
): Promise<Output<typeof getReadModelExportPage>> {
  const cursor = input.cursor === undefined ? { table: 0, after: null } : decode(input.cursor);
  await exportable(ctx);
  ctx.metrics.count("d1.query", { db: "org", op: "read_model_export" });
  const page = await fenced(() =>
    exportPage(readModelFor(ctx.env, DEFAULT_ORG_SHARD), input.generation, cursor),
  );
  return {
    table: page.table,
    rows: [...page.rows],
    next_cursor: page.next === null ? null : encode(page.next),
  };
}

const encode = (cursor: ExportCursor) =>
  btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** A cursor a page gave (its table's place and key), or 422. */
function decode(text: string): ExportCursor {
  const invalid = () =>
    new OperationError(422, "invalid_cursor", "`cursor` is not one a page gave.");
  let value: unknown;
  try {
    value = JSON.parse(atob(text.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw invalid();
  }
  const { table, after } = (value ?? {}) as { table?: unknown; after?: unknown };
  const spec = typeof table === "number" ? EXPORT_TABLES[table] : undefined;
  if (!spec || !Number.isInteger(table)) throw invalid();
  if (after === null) return { table: table as number, after: null };
  if (
    !Array.isArray(after) ||
    after.length !== spec.key.length ||
    !after.every((v) => typeof v === "string" || typeof v === "number")
  )
    throw invalid();
  return { table: table as number, after };
}
