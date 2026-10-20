import type { DomainEvent } from "@fyrden/domain";
import { z } from "zod";
import type { Effect, EffectSink, PlannedEffect } from "../effects/journal.js";
import { findReposById } from "../repos/directory.js";

/*
 * References and closes between repositories. A `reference.sync` event
 * (an issue's, pull request's or comment's text changed) becomes one
 * effect per other repository it names or named: that repository's object
 * replaces the source's references there, unless it applied a later event
 * of the source already. A `reference.close` event (a pull request merged
 * into its default branch) becomes one effect per issue it closes in
 * another repository: that repository checks the merger's credential and
 * closes the issue, or records the refusal for good. A repository gone (or
 * not active) is skipped; one being transferred is tried again later.
 */

const SyncSchema = z.object({
  source_number: z.number().int().positive(),
  source_comment: z.number().int().nonnegative(),
  source_kind: z.enum(["issue", "pull"]),
  repos: z.array(
    z.object({ repo_id: z.string().min(1), numbers: z.array(z.number().int().positive()) }),
  ),
});

const CloseSchema = z.object({
  source_number: z.number().int().positive(),
  token_id: z.string().min(1),
  targets: z.array(z.object({ repo_id: z.string().min(1), number: z.number().int().positive() })),
});

type Payload =
  | {
      readonly kind: "sync";
      readonly repoId: string;
      readonly sourceRepo: string;
      readonly sourceNumber: number;
      readonly sourceComment: number;
      readonly sourceKind: "issue" | "pull";
      readonly numbers: readonly number[];
      readonly epochGen: number;
      readonly sourceSeq: number;
    }
  | {
      readonly kind: "close";
      readonly repoId: string;
      readonly number: number;
      readonly principal: string;
      readonly tokenId: string;
      readonly actChain: readonly string[];
    };

export const referenceSink: EffectSink = {
  name: "references",
  // A source's repository id stays its own through a transfer, and a close's credential is checked
  // where it applies: an event before the transfer still holds after it.
  acrossTransfers: true,

  plan(event: DomainEvent): readonly PlannedEffect[] {
    if (event.type === "reference.sync") {
      const data = SyncSchema.safeParse(event.data);
      if (!data.success) return [];
      return data.data.repos.map((repo) => ({
        target: repo.repo_id,
        payload: {
          kind: "sync",
          repoId: repo.repo_id,
          sourceRepo: event.id.sourceId,
          sourceNumber: data.data.source_number,
          sourceComment: data.data.source_comment,
          sourceKind: data.data.source_kind,
          numbers: repo.numbers,
          epochGen: event.id.epochGen,
          sourceSeq: event.id.sourceSeq,
        } satisfies Payload,
      }));
    }
    if (event.type === "reference.close" && event.actor !== null) {
      const data = CloseSchema.safeParse(event.data);
      if (!data.success) return [];
      const actor = event.actor;
      return data.data.targets.map((target) => ({
        target: `${target.repo_id}#${target.number}`,
        payload: {
          kind: "close",
          repoId: target.repo_id,
          number: target.number,
          principal: actor,
          tokenId: data.data.token_id,
          actChain: [...event.actChain],
        } satisfies Payload,
      }));
    }
    return [];
  },

  async deliver(effect: Effect, env: Env): Promise<void> {
    const payload = effect.payload as unknown as Payload;
    // Never wakes the object of a repository that is gone (it would start empty storage).
    if ((await findReposById(env, [payload.repoId])).length === 0) return;
    const repo = env.REPO.getByName(payload.repoId);
    const outcome =
      payload.kind === "sync"
        ? await repo.applyReferences({
            sourceRepo: payload.sourceRepo,
            sourceNumber: payload.sourceNumber,
            sourceComment: payload.sourceComment,
            sourceKind: payload.sourceKind,
            numbers: payload.numbers,
            epochGen: payload.epochGen,
            sourceSeq: payload.sourceSeq,
          })
        : await repo.closeFromReference({
            effectId: effect.id,
            number: payload.number,
            principal: payload.principal,
            tokenId: payload.tokenId,
            actChain: payload.actChain,
          });
    if (outcome === "retry") throw new Error(`repository ${payload.repoId} is being transferred`);
  },
};
