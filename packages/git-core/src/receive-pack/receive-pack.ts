import type { RefSnapshot } from "../ports/ref-store.js";
import { findCapability, parseCapabilityList } from "../protocol/capabilities.js";
import { ProtocolError } from "../protocol/errors.js";
import { chompLf, MAX_PKT_LINE_LENGTH, PktLineReader } from "../protocol/pktline.js";
import { readPushBody, type StoredBody } from "./body.js";
import { liveCommands, type PushPlan, type PushPolicy, planPush } from "./commands.js";
import { type FinalizeEnv, finalizePush, type PushResult } from "./finalize.js";
import { type IndexOutcome, type PushIndexEnv, PushIndexer } from "./indexer.js";
import { encodeFatalError, encodePushResponse } from "./report.js";

export interface ReceivePackOptions {
  /** The stored request body. */
  readonly body: StoredBody;
  /** The refs the client was shown (the advertisement's snapshot), for the early checks. */
  readonly refs: RefSnapshot;
  /** Identifies this push's pending commit rows and pack unit. */
  readonly uploadId: string;
  readonly index: PushIndexEnv;
  readonly finalize: FinalizeEnv;
  readonly policy?: PushPolicy;
  /** Whether `push-options` was advertised (git then reads the options section). Default true. */
  readonly pushOptionsAdvertised?: boolean;
  /** Receives each indexing checkpoint (for `uploads.cursor`). */
  readonly onCheckpoint?: (cursor: Uint8Array) => void | Promise<void>;
}

export interface ReceivePackOutcome {
  /** The response body, sent with HTTP status 200 whatever happened. */
  readonly response: Uint8Array;
  /** Undefined when the request itself was malformed. */
  readonly plan?: PushPlan;
  readonly indexed?: IndexOutcome;
  readonly result?: PushResult;
}

/**
 * A whole push in one call: read the commands, check them, index the pack,
 * commit, and encode the response. For in-process servers (the test
 * transport); the Durable Object runs the same steps one request at a
 * time (`readPushBody`, `planPush`, `PushIndexer`, `finalizePush`,
 * `encodePushResponse`) so indexing can be resumed.
 *
 * An upload that did not commit has its pending commit rows discarded here;
 * its packs are left for the caller to discard.
 */
export async function receivePack(options: ReceivePackOptions): Promise<ReceivePackOutcome> {
  let plan: PushPlan;
  let packOffset: number;
  try {
    const body = await readPushBody(options.body, {
      pushOptionsAdvertised: options.pushOptionsAdvertised ?? true,
    });
    plan = planPush(body.request, options.refs, options.policy);
    packOffset = body.packOffset;
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    const sideband = await requestedSideband(options.body);
    return { response: encodeFatalError(error.message, sideband) };
  }

  let indexed: IndexOutcome | undefined;
  if (plan.expectsPack && liveCommands(plan).length > 0) {
    const indexer = PushIndexer.start({ uploadId: options.uploadId, packOffset, plan });
    indexed = await indexer.run(options.index, options.body, options.onCheckpoint);
  }
  const result = await finalizePush(plan, indexed, options.uploadId, options.finalize);
  if (!result.uploadCommitted) await options.index.commitGraph.discardPending(options.uploadId);
  return {
    response: encodePushResponse(result.report, plan.capabilities, result.messages),
    plan,
    ...(indexed ? { indexed } : {}),
    result,
  };
}

/**
 * Whether the first command asked for side-band, read from the body's first
 * packet only: how to send an error about the rest of the request.
 */
export async function requestedSideband(body: StoredBody): Promise<boolean> {
  try {
    const head = await body.read(0, Math.min(body.length, MAX_PKT_LINE_LENGTH));
    const first = new PktLineReader(head).read();
    if (first?.kind !== "data") return false;
    const line = chompLf(first.data);
    const nul = line.indexOf(0);
    if (nul < 0) return false;
    const caps = parseCapabilityList(line.subarray(nul + 1));
    return (
      findCapability(caps, "side-band-64k") !== undefined ||
      findCapability(caps, "side-band") !== undefined
    );
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}
