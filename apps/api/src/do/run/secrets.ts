/*
 * A job's secrets at its assignment: asked of the repository's account
 * object, which answers them sealed with the wrapped data keys that open
 * them, and opened here with the CI master keys. The values exist only in
 * the memory of the request that assigns the task.
 */
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { MAX_CI_VALUE_BYTES, MAX_REPO_SECRETS, MAX_RUN_ORG_SECRETS } from "@fyrden/domain";
import {
  MASK_SECRET_MAX_TEXT_BYTES,
  MASK_SECRET_MAX_VALUES,
  MASK_SECRET_MAX_VARIANT_BYTES,
  type SecretMaskOffer,
  type SecretReferences,
} from "@fyrden/domain/ci";
import { type CiKeyring, openSecretValue, unwrapDataKey } from "../../ci/envelope.js";
import type { SecretMasksAnswer } from "./logs.js";

/** A secret opened for a job, with where it was read from, for the delivery audit. */
export interface DeliveredSecret extends SecretMaskOffer {
  /** `org` or the repository id. */
  readonly scope: string;
  /** Its data key generation. */
  readonly generation: number;
}

export type ReadSecrets =
  | { readonly ok: true; readonly secrets: readonly DeliveredSecret[] }
  /** Some do not open: their names, never their values. */
  | { readonly ok: false; readonly code: "secrets_unavailable"; readonly names: readonly string[] }
  /** Their value text, counting each, is more than a job is given: their names and sizes, unopened. */
  | {
      readonly ok: false;
      readonly code: "secrets_oversize";
      readonly secrets: readonly { readonly name: string; readonly bytes: number }[];
    }
  /** The account object failed or refused: nothing is known, so nothing is decided. */
  | { readonly ok: false; readonly code: "unreachable"; readonly reason: string };

const MAX_DELIVERED = MAX_RUN_ORG_SECRETS + MAX_REPO_SECRETS;

/**
 * Value text a job is given at most, counting each secret, equal values
 * too: twice the masks' `MASK_SECRET_MAX_TEXT_BYTES`, so names that share a
 * value are delivered, while what one delivery reads stays bounded. Equal
 * values are known only once opened (each is sealed apart); the masks then
 * cap the distinct ones. Proposed.
 */
export const DELIVERY_MAX_TEXT_BYTES = 2 * MASK_SECRET_MAX_TEXT_BYTES;

/** The base64 text of a sealed value of `bytes` bytes (AES-GCM adds a 16-byte tag). */
const sealedChars = (bytes: number) => 4 * Math.ceil((bytes + 16) / 3);

/**
 * The memory masking and encoding a delivery take beside its read, bound by
 * the masks' caps whatever the task has had: its stored secret masks, which
 * a re-offer opens (up to `MASK_SECRET_MAX_TEXT_BYTES` of value text, read
 * as sealed base64 text at 2 bytes a character, and opened at up to 2 bytes
 * a UTF-8 byte), the new masks sealed the same way (their bytes, and the
 * text), the encoded task holding every delivered value, and 1 KiB a mask
 * for rows' ids and structure and the masked forms counted one value at a
 * time. About 3 MiB. Proposed.
 */
export const DELIVERY_MASKING_BYTES =
  2 * 2 * Math.ceil((4 * (MASK_SECRET_MAX_TEXT_BYTES + MASK_SECRET_MAX_VALUES * 16)) / 3) +
  2 * 2 * MASK_SECRET_MAX_TEXT_BYTES +
  DELIVERY_MAX_TEXT_BYTES +
  1024 * MASK_SECRET_MAX_VALUES;

/**
 * What a job's answer from its account may carry, for `refs`: the secrets
 * it can name (`all`: every one a job can be given), their values' text
 * (`bytes`, which the account compares each value's exact size against),
 * and the base64 text of their sealed values. A job is given
 * `DELIVERY_MAX_TEXT_BYTES` of value text at most, so no more is ever read.
 */
export function deliveryBound(refs: SecretReferences): {
  count: number;
  bytes: number;
  sealedChars: number;
} {
  const count = Math.min(refs.kind === "all" ? MAX_DELIVERED : refs.names.length, MAX_DELIVERED);
  const bytes = Math.min(count * MAX_CI_VALUE_BYTES, DELIVERY_MAX_TEXT_BYTES);
  // Each value's base64 rounds up to 4 characters past its share of the text.
  return { count, bytes, sealedChars: Math.ceil((4 * bytes) / 3) + count * (sealedChars(0) + 4) };
}

/**
 * The run object's memory delivering `refs` takes at most: the sealed text
 * as the answer is received and as it is kept (2 bytes a character), its
 * decoded bytes, the opened values (up to 2 bytes a UTF-8 byte as strings),
 * 1 KiB a secret for names and the answer's structure, and
 * `DELIVERY_MASKING_BYTES`. Proposed.
 */
export function deliveryMemory(refs: SecretReferences): number {
  const bound = deliveryBound(refs);
  return 2 * 2 * bound.sealedChars + 3 * bound.bytes + 1024 * bound.count + DELIVERY_MASKING_BYTES;
}

/**
 * The secrets `refs` names (every eligible one for `all`) of repository
 * `repoId` of account `accountId`, opened. A value that does not open (its
 * data key's master key gone, or a ciphertext that fails) makes the answer
 * `secrets_unavailable`, naming every such secret; secrets whose values
 * are past `deliveryBound`'s text are not sent, and the answer is
 * `secrets_oversize`. Never logs: a failure is answered as a stable reason.
 */
export async function readSecrets(
  env: Env,
  keys: CiKeyring,
  accountId: string,
  repoId: string,
  refs: SecretReferences,
  metrics: Metrics,
): Promise<ReadSecrets> {
  const bound = deliveryBound(refs);
  metrics.count("do.request", { class: "OrgDO", method: "ciSecretsFor" });
  const asked = await env.ORG.getByName(accountId)
    .ciSecretsFor(repoId, refs, bound.bytes)
    .then(
      (value) => ({ value }),
      () => ({ error: true }),
    );
  // The exception's text is not kept: it may carry what the account object was handling.
  if ("error" in asked) return { ok: false, code: "unreachable", reason: "account_failed" };
  const answer = asked.value;
  if (!answer.ok) return { ok: false, code: "unreachable", reason: answer.code };
  if (answer.value.oversize)
    return { ok: false, code: "secrets_oversize", secrets: answer.value.oversize };
  // The account object keeps to the bound; an answer past it is refused unopened.
  let chars = 0;
  for (const e of answer.value.entries) chars += e.ciphertext.length;
  if (chars > bound.sealedChars || answer.value.entries.length > bound.count)
    return { ok: false, code: "unreachable", reason: "answer_past_bound" };
  const dataKeys = new Map<number, Uint8Array | undefined>();
  try {
    for (const key of answer.value.dataKeys)
      dataKeys.set(
        key.generation,
        await unwrapDataKey(keys, { accountId, generation: key.generation }, key),
      );
    const secrets: DeliveredSecret[] = [];
    const unavailable: string[] = [];
    for (const e of answer.value.entries) {
      const dataKey = dataKeys.get(e.generation);
      const value =
        dataKey &&
        (await openSecretValue(
          dataKey,
          { accountId, scope: e.scope, name: e.name, generation: e.generation },
          e,
        ));
      if (value === undefined) unavailable.push(e.name);
      else secrets.push({ name: e.name, value, scope: e.scope, generation: e.generation });
    }
    if (unavailable.length > 0)
      return { ok: false, code: "secrets_unavailable", names: unavailable };
    return { ok: true, secrets };
  } finally {
    for (const key of dataKeys.values()) key?.fill(0);
  }
}

const LISTED = 10;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, LISTED).join(", ");
  return items.length > LISTED ? `${shown} and ${items.length - LISTED} more` : shown;
}

/** The job's error when secrets do not open: their names. */
export function unavailableError(names: readonly string[]): string {
  return `secrets_unavailable: these secrets do not open: set them again (${listed(names)})`;
}

const LIMITS: Record<Extract<SecretMasksAnswer, { code: "secrets_unmaskable" }>["limit"], string> =
  {
    values: `${MASK_SECRET_MAX_VALUES} values`,
    bytes: `${MASK_SECRET_MAX_TEXT_BYTES / 1024} KiB of value text`,
    variants: `${MASK_SECRET_MAX_VARIANT_BYTES / 1024} KiB of masked forms`,
  };

/** The job's error when secrets' value text, counting each, is more than a job is given: nothing was opened. */
export function oversizeError(
  secrets: Extract<ReadSecrets, { code: "secrets_oversize" }>["secrets"],
): string {
  return `secrets_unmaskable: these secrets are more than a job is given, ${DELIVERY_MAX_TEXT_BYTES / 1024} KiB of value text counting each secret: ${listed(
    secrets.map((s) => `${s.name} (${s.bytes} bytes)`),
  )}`;
}

/** The job's error when secrets do not fit its mask budget: their names and sizes. */
export function unmaskableError(
  refused: Extract<SecretMasksAnswer, { code: "secrets_unmaskable" }>,
): string {
  return `secrets_unmaskable: these secrets are past a job's mask budget of ${LIMITS[refused.limit]}: ${listed(
    refused.secrets.map(
      (s) => `${s.name} (${s.bytes} bytes, ${s.variantBytes} bytes of masked forms)`,
    ),
  )}`;
}
