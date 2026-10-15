import type {
  createRuleset,
  deleteRuleset,
  getRuleset,
  Input,
  listRuleSuites,
  listRulesets,
  Output,
  updateRuleset,
} from "@fyrden/api-contract";
import { pullRequestParameters } from "@fyrden/domain";
import type { RulesetInput, RulesetRecord } from "../do/repo/rulesets.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";

type RulesetOutput = Output<typeof getRuleset>;

function output(record: RulesetRecord): RulesetOutput {
  const { ruleset } = record;
  return {
    id: ruleset.id,
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: {
      ref_name: {
        include: [...ruleset.conditions.ref_name.include],
        exclude: [...ruleset.conditions.ref_name.exclude],
      },
    },
    rules: ruleset.rules.map((r) => {
      if (r.type !== "pull_request") return { type: r.type };
      // Stored before parameters existed, or partly: the defaults fill in.
      const parameters = pullRequestParameters(r);
      return {
        type: r.type,
        parameters: { ...parameters, allowed_merge_methods: [...parameters.allowed_merge_methods] },
      };
    }),
    bypass_actors: ruleset.bypass_actors.map((b) => ({ ...b })),
    actor_types: ruleset.actor_types ? [...ruleset.actor_types] : null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function inputOf(input: Input<typeof createRuleset>): RulesetInput {
  return {
    name: input.name,
    target: input.target,
    enforcement: input.enforcement,
    conditions: input.conditions,
    rules: input.rules.map(({ type, parameters }) => {
      if (!parameters) return { type };
      // An empty `required_reviewers` (sent by GitHub clients) requires nothing: not stored.
      const { required_reviewers: _none, ...kept } = parameters;
      return { type, parameters: kept };
    }),
    bypass_actors: input.bypass_actors,
    ...(input.actor_types && { actor_types: input.actor_types }),
  };
}

const notFound = (id: number) =>
  new OperationError(404, "ruleset_not_found", `The repository has no ruleset ${id}.`);

async function change(
  ctx: OpContext,
  entry: RepoEntry,
  request: Parameters<DurableObjectStub<import("../do/RepoDO.js").RepoDO>["changeRuleset"]>[0],
  id?: number,
): Promise<RulesetRecord | null> {
  ctx.metrics.count("do.request", { class: "RepoDO", method: "changeRuleset" });
  const result = await ctx.env.REPO.getByName(entry.id).changeRuleset(request, {
    principal: ctx.auth.principalId,
    tokenId: ctx.auth.id,
    grantId: ctx.auth.grantId,
    actChain: ctx.auth.act,
    requestId: ctx.requestId ?? null,
    via: "api",
  });
  if (result.ok) return result.record;
  switch (result.code) {
    case "not_found":
      throw notFound(id ?? 0);
    case "name_taken":
      throw new OperationError(422, "name_taken", "The repository has a ruleset with that name.");
    case "too_many":
      throw new OperationError(422, "too_many_rulesets", "A repository has 50 rulesets at most.");
    case "repo_transferring":
      throw new OperationError(
        409,
        "repo_transferring",
        "The repository is being transferred; its rulesets change once it lands.",
      );
    default:
      throw new OperationError(
        404,
        "repo_not_found",
        `No repository ${entry.ownerHandle}/${entry.name} was found.`,
      );
  }
}

/** The `repos.rulesets.list` operation. */
export async function listRulesetsOperation(
  ctx: OpContext,
  input: Input<typeof listRulesets>,
): Promise<Output<typeof listRulesets>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "rulesets" });
  const { rulesets } = await ctx.env.REPO.getByName(entry.id).rulesets();
  return { rulesets: rulesets.map(output) };
}

/** The `repos.rulesets.rule_suites.list` operation. */
export async function listRuleSuitesOperation(
  ctx: OpContext,
  input: Input<typeof listRuleSuites>,
): Promise<Output<typeof listRuleSuites>> {
  // The cursor is the last suite's id.
  const after = decodeCursor(input.cursor, (id) => /^[1-9][0-9]{0,15}$/.test(id));
  const entry = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "ruleSuites" });
  const suites = await ctx.env.REPO.getByName(entry.id).ruleSuites(
    input.per_page + 1,
    after === "" ? undefined : Number(after),
  );
  const page = suites.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    rule_suites: page.map((s) => ({
      id: s.id,
      ref: s.ref,
      before_sha: s.before,
      after_sha: s.after,
      actor_id: s.actorId,
      pushed_at: s.pushedAt,
      result: s.refused ? ("fail" as const) : ("pass" as const),
      evaluation_result: "fail" as const,
      rule_evaluations: s.evaluations.map((e) => ({
        rule_source: { type: "ruleset" as const, id: e.rulesetId, name: e.ruleset },
        enforcement: "evaluate" as const,
        result: "fail" as const,
        rule_type: e.rule,
        details: e.message,
      })),
    })),
    next_cursor: suites.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

/** The `repos.rulesets.get` operation. */
export async function getRulesetOperation(
  ctx: OpContext,
  input: Input<typeof getRuleset>,
): Promise<Output<typeof getRuleset>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "rulesets" });
  const { rulesets } = await ctx.env.REPO.getByName(entry.id).rulesets();
  const record = rulesets.find((r) => r.ruleset.id === input.ruleset_id);
  if (!record) throw notFound(input.ruleset_id);
  return output(record);
}

/** The `repos.rulesets.create` operation. */
export async function createRulesetOperation(
  ctx: OpContext,
  input: Input<typeof createRuleset>,
): Promise<Output<typeof createRuleset>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  return output(
    (await change(ctx, entry, { op: "create", input: inputOf(input) })) as RulesetRecord,
  );
}

/** The `repos.rulesets.update` operation. */
export async function updateRulesetOperation(
  ctx: OpContext,
  input: Input<typeof updateRuleset>,
): Promise<Output<typeof updateRuleset>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const record = await change(
    ctx,
    entry,
    { op: "update", id: input.ruleset_id, input: inputOf(input) },
    input.ruleset_id,
  );
  return output(record as RulesetRecord);
}

/** The `repos.rulesets.delete` operation. */
export async function deleteRulesetOperation(
  ctx: OpContext,
  input: Input<typeof deleteRuleset>,
): Promise<Output<typeof deleteRuleset>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  await change(ctx, entry, { op: "delete", id: input.ruleset_id }, input.ruleset_id);
  return { id: input.ruleset_id, state: "deleted" };
}
