import { describe, expect, it } from "vitest";
import {
  type InstanceHandle,
  isUnsupported,
  type JobRequirements,
  type ProviderCapabilities,
  type RunnerProvider,
} from "../src/provider.js";

/**
 * A fresh provider, and how a test drives what stands behind it: something
 * whose lists, if they have pages, have at most 100 instances on each, so that
 * the suite reaches a second one.
 */
export interface ProviderUnderTest {
  readonly provider: RunnerProvider;
  /** A job it runs (any job, for one that provisions nothing). */
  readonly supported: JobRequirements;
  /** Jobs it cannot run, each for one reason. */
  readonly unsupported: readonly JobRequirements[];
  /** Calls made to what stands behind it so far. */
  calls(): number;
  /** Instances made behind it so far, those gone again too, as what stands behind it counts them. */
  made(): number;
  /** Instances behind it now, as what stands behind it counts them. */
  live(): number;
  /** While on, every call to what stands behind it fails. A provider that provisions has it. */
  outage?(on: boolean): void;
  /** The next `provision` makes its instance and its answer is lost. A provider that provisions has it. */
  loseNextResponse?(): void;
}

export interface ProviderRule {
  readonly name: string;
  readonly appliesTo: (capabilities: ProviderCapabilities) => boolean;
  /** What breaks the rule, each in a line; none when it holds. */
  readonly violations: (subject: ProviderUnderTest) => Promise<string[]>;
}

/** Stands for a registration token: found nowhere but in the call it was given to. */
const TOKEN = "registration-token-do-not-leak";
const REGISTRATION = Object.freeze({ token: TOKEN });
const always = () => true;
const hosted = (c: ProviderCapabilities) => c.provisions;
const unprovisioned = (c: ProviderCapabilities) => !c.provisions;
const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
/** More instances than a page of a list may hold here. */
const MANY = 120;

/** What a value holds: its own properties, enumerable or not, its name, and a collection's entries. */
function held(value: object): unknown[] {
  const own = [...Reflect.ownKeys(value), "name"].flatMap((key) => {
    try {
      return [String(key), Reflect.get(value, key)];
    } catch {
      return [String(key)];
    }
  });
  const collection = value instanceof Map || value instanceof Set || value instanceof Headers;
  return collection ? [...own, ...value] : own;
}

/** Whether the token is in a value, however deep: in an error's cause, say. */
function hasToken(value: unknown): boolean {
  const seen = new Set<unknown>();
  const left = [value];
  while (left.length > 0) {
    const next = left.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (typeof next === "object" && next !== null) {
      for (const part of held(next)) left.push(part);
    } else if (String(next).includes(TOKEN)) return true;
  }
  return false;
}

/** Collects what is false, so a rule reads as what must hold. */
function checks() {
  const broken: string[] = [];
  return {
    broken,
    that: (holds: boolean, otherwise: string) => {
      if (!holds) broken.push(otherwise);
    },
  };
}

async function made(subject: ProviderUnderTest, intent: string): Promise<InstanceHandle | null> {
  const answer = await subject.provider.provision(subject.supported, REGISTRATION, intent);
  return isUnsupported(answer) ? null : answer;
}

/** Whether two lists hold the same handles, whole, in any order. */
function same(a: readonly InstanceHandle[], b: readonly InstanceHandle[]): boolean {
  const lines = (handles: readonly InstanceHandle[]) =>
    handles
      .map(({ providerId, instanceId, intent }) => JSON.stringify([providerId, instanceId, intent]))
      .sort()
      .join();
  return lines(a) === lines(b);
}

export const PROVIDER_RULES: readonly ProviderRule[] = [
  {
    name: "describe and estimate call nothing and answer the same each time",
    appliesTo: always,
    violations: async (subject) => {
      const { provider, supported } = subject;
      const { broken, that } = checks();
      that(provider.id !== "", "it has no id");
      const described = JSON.stringify(provider.describe());
      const estimated = JSON.stringify(provider.estimate(supported));
      that(JSON.stringify(provider.describe()) === described, "describe changed its answer");
      that(
        JSON.stringify(provider.estimate(supported)) === estimated,
        "estimate changed its answer",
      );
      that(subject.calls() === 0, "making it, describe or estimate called its service");
      return broken;
    },
  },
  {
    name: "a lifetime is a positive whole number or none, and a network per job comes with Docker",
    appliesTo: always,
    violations: async ({ provider }) => {
      const { broken, that } = checks();
      const c = provider.describe();
      that(
        c.maxLifetimeMs === null || (whole(c.maxLifetimeMs) && c.maxLifetimeMs > 0),
        `maxLifetimeMs is ${c.maxLifetimeMs}`,
      );
      that(
        c.containerNetworking !== "per_job" || c.docker === true,
        "a network per job without Docker",
      );
      return broken;
    },
  },
  {
    name: "an estimate is whole numbers with a billing step",
    appliesTo: always,
    violations: async ({ provider, supported }) => {
      const { broken, that } = checks();
      const estimate = provider.estimate(supported);
      if (isUnsupported(estimate)) return ["it has no estimate for a job it runs"];
      that(whole(estimate.microUsdPerMinute), `the price is ${estimate.microUsdPerMinute}`);
      that(
        whole(estimate.billingStepMs) && estimate.billingStepMs > 0,
        `the billing step is ${estimate.billingStepMs}`,
      );
      that(whole(estimate.expectedBootMs), `the boot time is ${estimate.expectedBootMs}`);
      return broken;
    },
  },
  {
    name: "a job it cannot run is refused by its estimate and by provision, which makes nothing",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider, unsupported } = subject;
      const { broken, that } = checks();
      that(unsupported.length > 0, "no job it cannot run was given");
      for (const req of unsupported) {
        that(isUnsupported(provider.estimate(req)), `an estimate for ${JSON.stringify(req)}`);
        const answer = await provider.provision(req, REGISTRATION, "refused-1");
        that(isUnsupported(answer), `an instance for ${JSON.stringify(req)}`);
      }
      // Counted behind it: under whatever intent, and gone again or not.
      that(subject.made() === 0, `refusals made ${subject.made()} instances`);
      return broken;
    },
  },
  {
    name: "provision makes one live instance, tagged with its intent",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider } = subject;
      const { broken, that } = checks();
      const handle = await made(subject, "one-1");
      if (!handle) return ["it refused a job it runs"];
      that(subject.made() === 1, `it made ${subject.made()} instances`);
      that(handle.providerId === provider.id, "the handle names another provider");
      that(handle.intent === "one-1", "the handle has another intent");
      that(handle.instanceId !== "", "the handle has no instance id");
      const listed = await provider.listOrphans("one-1");
      that(listed.length === 1, `${listed.length} instances have its intent`);
      const status = await provider.status(handle);
      that(status !== "gone" && !isUnsupported(status), `its status is ${JSON.stringify(status)}`);
      return broken;
    },
  },
  {
    name: "an instance whose answer was lost is found by its intent, and torn down",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider } = subject;
      const { broken, that } = checks();
      if (!subject.loseNextResponse) return ["no way to lose an answer was given"];
      subject.loseNextResponse();
      let lost = false;
      await provider.provision(subject.supported, REGISTRATION, "lost-1").catch(() => {
        lost = true;
      });
      that(lost, "the lost answer was an answer");
      const found = await provider.listOrphans("lost-1");
      that(found.length === 1, `${found.length} instances have the lost intent`);
      that(subject.made() === 1, `it made ${subject.made()} instances`);
      const handle = found[0];
      if (!handle) return broken;
      that(handle.intent === "lost-1", "the instance found has another intent");
      that((await provider.status(handle)) !== "gone", "the instance found is gone");
      await provider.teardown(handle);
      that((await provider.listOrphans("lost-1")).length === 0, "it is still there");
      return broken;
    },
  },
  {
    name: "teardown is done when the instance is gone, the second time too",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider } = subject;
      const { broken, that } = checks();
      const handle = await made(subject, "down-1");
      if (!handle) return ["it refused a job it runs"];
      await provider.teardown(handle);
      that(subject.live() === 0, "it is there still");
      that((await provider.status(handle)) === "gone", "its status is not gone");
      that((await provider.listOrphans("down-1")).length === 0, "it is still listed");
      await provider.teardown(handle).catch(() => {
        broken.push("tearing down an instance that is gone failed");
      });
      return broken;
    },
  },
  {
    name: "teardown leaves every other instance",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider } = subject;
      const { broken, that } = checks();
      const gone = await made(subject, "pair-1");
      const kept = await made(subject, "pair-2");
      if (!gone || !kept) return ["it refused a job it runs"];
      that(gone.instanceId !== kept.instanceId, "two instances share an id");
      await provider.teardown(gone);
      that((await provider.status(kept)) !== "gone", "another instance went with it");
      // Nor one made since: a handle is never another instance's.
      const later = await made(subject, "pair-1");
      if (!later) return ["it refused a job it runs"];
      that(later.instanceId !== gone.instanceId, "a later instance has its id");
      await provider.teardown(gone).catch(() => null);
      that((await provider.status(later)) !== "gone", "a later instance went with it");
      return broken;
    },
  },
  {
    name: "listOrphans lists the instances whose intent begins with the tag, and no other",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider } = subject;
      const { broken, that } = checks();
      // With the intent each was given, whatever its handle says.
      const make = async (intent: string) => {
        const handle = await made(subject, intent);
        return handle && { ...handle, intent };
      };
      const task = await make("task");
      const extra = await make("task-extra");
      const other = await make("other-task");
      const cased = await make("Cased");
      if (!task || !extra || !other || !cased) return ["it refused a job it runs"];
      const lists = async (tag: string, expected: readonly InstanceHandle[]) => {
        const listed = await provider.listOrphans(tag);
        that(
          same(listed, expected),
          `${JSON.stringify(tag)} lists ${JSON.stringify(listed)}, not ${JSON.stringify(expected)}`,
        );
      };
      // Each as it was made: its own intent, not the one asked for.
      await lists("task", [task, extra]);
      await lists("task-", [extra]);
      await lists("Cased", [cased]);
      await lists("cased", []);
      // Not a match anywhere in an intent.
      await lists("extra", []);
      const many: InstanceHandle[] = [];
      for (let n = 0; n < MANY; n++) {
        const handle = await make(`many-${n}`);
        if (handle) many.push(handle);
      }
      that(many.length === MANY, `it made ${many.length} of ${MANY}`);
      that(same(await provider.listOrphans("many-"), many), `it lists not all ${MANY} it made`);
      return broken;
    },
  },
  {
    name: "a service that fails is an error, never a list, a status or a teardown that is done",
    appliesTo: hosted,
    violations: async (subject) => {
      const { provider } = subject;
      const { broken, that } = checks();
      if (!subject.outage) return ["no way to make its service fail was given"];
      const handle = await made(subject, "out-1");
      if (!handle) return ["it refused a job it runs"];
      const fails = (call: Promise<unknown>) =>
        call.then(
          () => false,
          () => true,
        );
      subject.outage(true);
      try {
        that(await fails(provider.listOrphans("out-1")), "it listed instances");
        that(await fails(provider.teardown(handle)), "its teardown was done");
        that(await fails(provider.status(handle)), "it had a status");
      } finally {
        subject.outage(false);
      }
      return broken;
    },
  },
  {
    name: "the registration token is in no handle, list, refusal or error",
    appliesTo: always,
    violations: async (subject) => {
      const { provider, supported, unsupported } = subject;
      const { broken, that } = checks();
      const clean = async (what: string, call: Promise<unknown>) => {
        const answer = await call.catch((error: unknown) => error);
        that(!hasToken(answer), `${what} carries the token`);
      };
      const provision = (req: JobRequirements, intent: string) =>
        provider.provision(req, REGISTRATION, intent);
      const answer = provision(supported, "token-1");
      await clean("a provision's answer", answer);
      await clean("a list", provider.listOrphans("token-"));
      for (const req of unsupported) await clean("a refusal", provision(req, "token-2"));
      if (subject.loseNextResponse) {
        subject.loseNextResponse();
        await clean("a lost answer's error", provision(supported, "token-3"));
      }
      if (subject.outage) {
        const handle = await answer.catch(() => null);
        subject.outage(true);
        try {
          await clean("a failed provision", provision(supported, "token-4"));
          await clean("a failed list", provider.listOrphans("token-"));
          if (handle && !isUnsupported(handle)) {
            await clean("a failed status", provider.status(handle));
            await clean("a failed teardown", provider.teardown(handle));
          }
        } finally {
          subject.outage(false);
        }
      }
      return broken;
    },
  },
  {
    name: "one that provisions nothing costs nothing, refuses to, and has no instances",
    appliesTo: unprovisioned,
    violations: async ({ provider, supported }) => {
      const { broken, that } = checks();
      const estimate = provider.estimate(supported);
      that(!isUnsupported(estimate) && estimate.microUsdPerMinute === 0, "it costs something");
      const answer = await provider.provision(supported, REGISTRATION, "none-1");
      that(isUnsupported(answer), "it provisioned");
      const handle = { providerId: provider.id, instanceId: "none", intent: "none-1" };
      that(isUnsupported(await provider.status(handle)), "it has a status for an instance");
      await provider.teardown(handle).catch(() => {
        broken.push("its teardown failed");
      });
      that((await provider.listOrphans("")).length === 0, "it lists instances");
      return broken;
    },
  },
];

/** The rules `create`'s providers break, with how; a fresh provider for each rule. */
export async function ruleViolations(
  create: () => ProviderUnderTest,
): Promise<{ readonly rule: string; readonly violations: readonly string[] }[]> {
  const found = [];
  for (const rule of PROVIDER_RULES) {
    const subject = create();
    if (!rule.appliesTo(subject.provider.describe())) continue;
    const violations = await rule.violations(subject);
    if (violations.length > 0) found.push({ rule: rule.name, violations });
  }
  return found;
}

/** The behaviour every `RunnerProvider` must have. `create` makes a provider with no instances. */
export function describeProviderContract(name: string, create: () => ProviderUnderTest): void {
  describe(`${name}: RunnerProvider contract`, () => {
    for (const rule of PROVIDER_RULES)
      if (rule.appliesTo(create().provider.describe()))
        it(rule.name, async () => {
          expect(await rule.violations(create())).toEqual([]);
        });
  });
}
