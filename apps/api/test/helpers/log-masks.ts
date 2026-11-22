import { env } from "cloudflare:workers";
import { ciSecretKeys, openMask } from "../../src/ci/envelope.js";
import type { RunDO } from "../../src/do/RunDO.js";
import { type MaskKind, maskAdditionalData } from "../../src/do/run/logs.js";
import { inRun } from "./runs.js";

/** A `ci_log_masks` row as stored. */
export interface StoredMaskRow {
  task: number;
  seq: number;
  kind: MaskKind;
  from_index: number;
  mask_id: string;
  cross_len: number;
  key_id: string | null;
  value: string;
}

export const storedMasksOf = (runId: string, task: number) =>
  inRun(runId, (r) =>
    r.engine.rows<StoredMaskRow>("SELECT * FROM ci_log_masks WHERE task = ? ORDER BY seq", task),
  );

/** The task's masks in order, each value opened under the deployment's keys (undefined: does not open). */
export async function openedMasksOf(
  runId: string,
  task: number,
): Promise<{ seq: number; kind: MaskKind; from_index: number; value: string | undefined }[]> {
  const keys = await ciSecretKeys(env);
  return Promise.all(
    (await storedMasksOf(runId, task)).map(async (m) => {
      const opened = async () => {
        if (m.key_id === null) return m.value;
        // Split at the first dot, as the run does: anything after the ciphertext stays in it.
        const dot = m.value.indexOf(".");
        if (dot === -1) return undefined;
        return openMask(keys, maskAdditionalData(runId, task, m.mask_id, m.kind), {
          masterKeyId: m.key_id,
          nonce: m.value.slice(0, dot),
          ciphertext: m.value.slice(dot + 1),
        });
      };
      return { seq: m.seq, kind: m.kind, from_index: m.from_index, value: await opened() };
    }),
  );
}

/**
 * Appends a plain mask row (no key id), as the v7 migration copies one: a
 * fresh id and a crossing length of six times its UTF-8 length.
 */
export function insertPlainMask(
  r: RunDO,
  task: number,
  kind: MaskKind,
  fromIndex: number,
  value: string,
  seq?: number,
): void {
  r.engine.exec(
    `INSERT INTO ci_log_masks (task, seq, kind, from_index, mask_id, cross_len, key_id, value)
     VALUES (?1, COALESCE(?5, (SELECT MAX(seq) + 1 FROM ci_log_masks WHERE task = ?1), 0), ?2, ?3,
       lower(hex(randomblob(16))), 6 * length(CAST(?4 AS BLOB)), NULL, ?4)`,
    task,
    kind,
    fromIndex,
    value,
    seq ?? null,
  );
}
