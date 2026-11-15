// The runner protocol's service: the methods a self-hosted runner calls under
// /api/actions/, its authentication and the deployment switch.

import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import { generateToken, hashToken, parseToken, secureRandomBytes } from "@fyrden/domain";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import type { ReportTaskAnswer } from "../do/run/dispatch.js";
import type { AppendLogAnswer } from "../do/run/logs.js";
import { clock } from "../services.js";
import { admitEveryRunner, type RunnerAdmission } from "./admission.js";
import {
  type ConnectCode,
  checkConnectRequest,
  connectError,
  MAX_SMALL_CALL_BYTES,
  MAX_UPDATE_TASK_BYTES,
  protoResponse,
  readPrefix,
  UPDATE_LOG_PREFIX_BYTES,
} from "./connect.js";
import { dispatchTask, TaskUnavailable } from "./dispatch.js";
import {
  BODY_TOO_LARGE,
  CREDENTIALS_REFUSED,
  FIELD_TOO_LONG,
  INVALID_MESSAGE,
  NAME_REQUIRED,
  RATE_LIMITED,
  REGISTRATION_OFF,
  REGISTRATION_REFUSED,
  RUNNER_SPENT,
  TASK_ID_MISSING,
  TASK_NOT_FOUND,
  TASK_OF_ANOTHER_RUNNER,
  TASK_SUPERSEDED,
  TASK_UNAVAILABLE,
  TOO_MANY_LABELS,
  unknownMethod,
} from "./errors.js";
import {
  decodeDeclareRequest,
  decodeFetchTaskRequest,
  decodePingRequest,
  decodeRegisterRequest,
  encodeDeclareResponse,
  encodeFetchTaskResponse,
  encodePingResponse,
  encodeRegisterResponse,
  type Runner,
  scanTaskId,
} from "./proto/messages.js";
import { ProtoError } from "./proto/wire.js";
import {
  type AuthenticatedRunner,
  authenticateRunner,
  declareRunner,
  type RunnerAuthentication,
  registerRunner,
} from "./registry.js";

export const RUNNER_SERVICE_PREFIX = "/api/actions/";

/** Longest runner name, version or label kept. */
const MAX_FIELD_LENGTH = 255;
/** Most labels a runner may declare. */
const MAX_LABELS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether runners may register and are offered work: the Worker variable
 * `FYRDEN_CI_RUNNERS` set to `on` (off otherwise). Turning it off leaves
 * registered runners polling with nothing to do, so it can be turned on again.
 */
export function runnersOn(env: object): boolean {
  return (env as { FYRDEN_CI_RUNNERS?: unknown }).FYRDEN_CI_RUNNERS === "on";
}

/** A refusal a method answers as a Connect error. */
class Refusal extends Error {
  constructor(
    readonly code: ConnectCode,
    message: string,
  ) {
    super(message);
  }
}

interface CallContext {
  readonly c: Context<AppEnv>;
  readonly env: Env;
  readonly metrics: Metrics;
  readonly admission: RunnerAdmission;
  readonly now: number;
  log: Logger;
}

type Method = (call: CallContext) => Promise<Response>;

const METHODS: Readonly<Record<string, Method>> = {
  "ping.v1.PingService/Ping": ping,
  "runner.v1.RunnerService/Register": register,
  "runner.v1.RunnerService/Declare": declare,
  "runner.v1.RunnerService/FetchTask": fetchTask,
  "runner.v1.RunnerService/UpdateTask": updateTask,
  "runner.v1.RunnerService/UpdateLog": updateLog,
};

/** Mounts the runner service; before the REST routes, which share the /api prefix. */
export function mountRunnerService(app: Hono<AppEnv>): void {
  app.all(`${RUNNER_SERVICE_PREFIX}*`, (c) => serve(c));
}

async function serve(c: Context<AppEnv>): Promise<Response> {
  const refused = checkConnectRequest(c.req.raw);
  if (refused) return refused;
  const name = new URL(c.req.url).pathname.slice(RUNNER_SERVICE_PREFIX.length);
  const method = Object.hasOwn(METHODS, name) ? METHODS[name] : undefined;
  if (!method) return connectError("unimplemented", unknownMethod(name));
  // Every call spends the runner limiter before anything is looked up, so
  // made-up credentials cannot drive reads of the directory's primary.
  if (!(await c.env.RATE_LIMIT_RUNNER.limit({ key: clientAddress(c) })).success)
    return connectError("resource_exhausted", RATE_LIMITED);
  const call: CallContext = {
    c,
    env: c.env,
    metrics: c.get("metrics"),
    admission: admitEveryRunner,
    now: clock(),
    log: c.get("log"),
  };
  try {
    return await method(call);
  } catch (error) {
    if (error instanceof Refusal) return connectError(error.code, error.message);
    if (error instanceof ProtoError) return connectError("invalid_argument", INVALID_MESSAGE);
    if (error instanceof TaskUnavailable) return connectError("unavailable", TASK_UNAVAILABLE);
    throw error;
  }
}

const clientAddress = (c: Context<AppEnv>) => c.req.header("CF-Connecting-IP") ?? "unknown";

async function smallBody(call: CallContext): Promise<Uint8Array> {
  const { bytes, truncated } = await readPrefix(call.c.req.raw, MAX_SMALL_CALL_BYTES);
  if (truncated) throw new Refusal("resource_exhausted", BODY_TOO_LARGE);
  return bytes;
}

async function ping(call: CallContext): Promise<Response> {
  const { data } = decodePingRequest(await smallBody(call));
  return protoResponse(encodePingResponse({ data: `Hello, ${data}!` }));
}

/** Labels and version as a runner sends them, within what is kept. */
function checkDeclared(version: string, labels: readonly string[]): void {
  if (labels.length > MAX_LABELS) throw new Refusal("invalid_argument", TOO_MANY_LABELS);
  if (version.length > MAX_FIELD_LENGTH || labels.some((l) => l.length > MAX_FIELD_LENGTH))
    throw new Refusal("invalid_argument", FIELD_TOO_LONG);
}

async function register(call: CallContext): Promise<Response> {
  // A registration token can be guessed at, as a sign-in can.
  if (!(await call.env.RATE_LIMIT_AUTH.limit({ key: clientAddress(call.c) })).success)
    throw new Refusal("resource_exhausted", RATE_LIMITED);
  if (!runnersOn(call.env)) throw new Refusal("failed_precondition", REGISTRATION_OFF);
  const request = decodeRegisterRequest(await smallBody(call));
  if (request.name === "") throw new Refusal("invalid_argument", NAME_REQUIRED);
  if (request.name.length > MAX_FIELD_LENGTH) throw new Refusal("invalid_argument", FIELD_TOO_LONG);
  checkDeclared(request.version, request.labels);
  const parsed = parseToken(request.token);
  if (!parsed.ok || parsed.type !== "run")
    throw new Refusal("permission_denied", REGISTRATION_REFUSED);

  const uuid = crypto.randomUUID();
  const token = generateToken("rnr", secureRandomBytes);
  const registered = await registerRunner(
    call.env.DIRECTORY,
    {
      registrationHash: await hashToken(request.token),
      nonce: crypto.randomUUID(),
      // Read now, not when the call began: a token that expires while its
      // body is still arriving is spent by then.
      now: clock(),
      uuid,
      tokenHash: await hashToken(token),
      name: request.name,
      version: request.version,
      labels: request.labels,
      ephemeral: request.ephemeral,
    },
    call.metrics,
  );
  if (!registered) throw new Refusal("permission_denied", REGISTRATION_REFUSED);
  await call.admission.onRegister(registered.accountId);
  call.log.info("runner registered", {
    runnerId: registered.id,
    runnerUuid: uuid,
    accountId: registered.accountId,
    ephemeral: request.ephemeral,
  });
  return protoResponse(
    encodeRegisterResponse({
      runner: runnerMessage(
        {
          id: registered.id,
          uuid,
          name: request.name,
          version: request.version,
          labels: request.labels,
          ephemeral: request.ephemeral,
        },
        token,
      ),
    }),
  );
}

/** The runner as the protocol carries it; its credential only in Register's answer. */
function runnerMessage(
  runner: Pick<AuthenticatedRunner, "id" | "uuid" | "name" | "version" | "labels" | "ephemeral">,
  token = "",
): Runner {
  return {
    id: runner.id,
    uuid: runner.uuid,
    token,
    name: runner.name,
    status: 0,
    agentLabels: [],
    customLabels: [],
    version: runner.version,
    labels: [...runner.labels],
    // The runner treats a registration not echoed as ephemeral as run-once (measured).
    ephemeral: runner.ephemeral,
  };
}

/**
 * The runner whose `x-runner-uuid` and `x-runner-token` the request carries,
 * or `unauthenticated`, which makes the runner stop (measured). Its id and
 * uuid are added to every later log line of the request; its token never is.
 * The same read brings the task the call names, or FetchTask's view.
 */
async function authenticate(
  call: CallContext,
  options: { taskId?: number; fetchVersion?: number } = {},
): Promise<RunnerAuthentication> {
  const uuid = call.c.req.header("x-runner-uuid") ?? "";
  const token = call.c.req.header("x-runner-token") ?? "";
  const parsed = parseToken(token);
  if (!UUID.test(uuid) || !parsed.ok || parsed.type !== "rnr")
    throw new Refusal("unauthenticated", CREDENTIALS_REFUSED);
  const found = await authenticateRunner(
    call.env.DIRECTORY,
    { uuid, tokenHash: await hashToken(token), now: call.now, ...options },
    call.metrics,
  );
  if (!found) throw new Refusal("unauthenticated", CREDENTIALS_REFUSED);
  const { runner } = found;
  call.log = call.log.child({ runnerId: runner.id, runnerUuid: runner.uuid });
  call.c.set("log", call.log);
  return found;
}

/** A spent ephemeral runner may only report on its task. */
function notSpent(runner: AuthenticatedRunner): void {
  if (runner.spent) throw new Refusal("unauthenticated", RUNNER_SPENT);
}

async function declare(call: CallContext): Promise<Response> {
  const { runner } = await authenticate(call);
  notSpent(runner);
  const request = decodeDeclareRequest(await smallBody(call));
  checkDeclared(request.version, request.labels);
  await declareRunner(
    call.env.DIRECTORY,
    { id: runner.id, version: request.version, labels: request.labels, now: call.now },
    call.metrics,
  );
  call.log.info("runner declared", { version: request.version, labels: request.labels });
  return protoResponse(
    encodeDeclareResponse({
      runner: runnerMessage({ ...runner, version: request.version, labels: request.labels }),
    }),
  );
}

async function fetchTask(call: CallContext): Promise<Response> {
  // The version is read before authenticating, which reads the account's state with the runner.
  let request: ReturnType<typeof decodeFetchTaskRequest>;
  try {
    request = decodeFetchTaskRequest(await smallBody(call));
  } catch (error) {
    // Bad credentials are answered as such whatever the body.
    await authenticate(call);
    throw error;
  }
  const { runner, dispatch } = await authenticate(call, { fetchVersion: request.tasksVersion });
  notSpent(runner);
  // Off: no task, with the runner's own version, so it keeps polling idle.
  if (!runnersOn(call.env) || !dispatch)
    return protoResponse(encodeFetchTaskResponse({ tasksVersion: request.tasksVersion }));
  await call.admission.onFetch(runner, call.now);
  return protoResponse(
    await dispatchTask(
      {
        env: call.env,
        metrics: call.metrics,
        log: call.log,
        now: call.now,
        timeoutHeader: call.c.req.header("connect-timeout-ms"),
      },
      runner,
      dispatch,
      request.tasksVersion,
    ),
  );
}

/** The task a report names, as the directory has it: refused unless it is the runner's, assigned and not superseded. */
function reportedTask(
  call: CallContext,
  { runner, task }: RunnerAuthentication,
): NonNullable<RunnerAuthentication["task"]> {
  if (!task) throw new Refusal("not_found", TASK_NOT_FOUND);
  if (task.runnerId !== runner.id) throw new Refusal("permission_denied", TASK_OF_ANOTHER_RUNNER);
  if (task.superseded) throw new Refusal("failed_precondition", TASK_SUPERSEDED);
  // An offer whose assignment the directory never recorded is no task of this runner's yet.
  if (!task.assigned) throw new Refusal("not_found", TASK_NOT_FOUND);
  call.log = call.log.child({ taskId: task.id, runId: task.runId });
  call.c.set("log", call.log);
  return task;
}

/** Answers a run's report: its encoded response, or its Connect error; the run unreachable is `unavailable`. */
async function fromRun(
  call: CallContext,
  what: string,
  ask: () => Promise<ReportTaskAnswer | AppendLogAnswer>,
): Promise<Response> {
  let answer: ReportTaskAnswer | AppendLogAnswer;
  try {
    answer = await ask();
  } catch (error) {
    call.log.warn(`${what} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Refusal("unavailable", TASK_UNAVAILABLE);
  }
  if (!answer.ok) throw new Refusal(answer.code, answer.message);
  return protoResponse(answer.response);
}

/**
 * The runner's report on its task, routed by the task id scanned from the
 * body (the Worker decodes no steps or outputs) to the task's run, which
 * decodes, confirms, heartbeats or completes it and answers.
 */
async function updateTask(call: CallContext): Promise<Response> {
  const { bytes, truncated } = await readPrefix(call.c.req.raw, MAX_UPDATE_TASK_BYTES);
  const taskId = truncated ? undefined : scanTaskId(bytes, "update_task");
  const found = await authenticate(call, taskId === undefined ? {} : { taskId });
  if (truncated) throw new Refusal("resource_exhausted", BODY_TOO_LARGE);
  if (taskId === undefined) throw new Refusal("invalid_argument", TASK_ID_MISSING);
  const task = reportedTask(call, found);
  call.metrics.count("do.request", { class: "RunDO", method: "reportTask" });
  return fromRun(call, "task report", () =>
    call.env.RUN.getByName(task.runId).reportTask(task.id, bytes, found.runner.id),
  );
}

/**
 * The runner's log rows for its task: at most the first 4 MiB of the body
 * (a longer one is passed on as a prefix, whose complete rows may be
 * stored), routed by the scanned task id to the task's run, which decodes
 * the rows, stores what it takes and answers with the stored ack.
 */
async function updateLog(call: CallContext): Promise<Response> {
  const { bytes, truncated } = await readPrefix(call.c.req.raw, UPDATE_LOG_PREFIX_BYTES);
  let taskId: number | undefined;
  let unreadable: unknown;
  try {
    taskId = scanTaskId(bytes, "update_log");
  } catch (error) {
    // Bad credentials are answered as such whatever the body.
    unreadable = error;
  }
  const found = await authenticate(call, taskId === undefined ? {} : { taskId });
  if (unreadable !== undefined) throw unreadable;
  if (taskId === undefined) throw new Refusal("invalid_argument", TASK_ID_MISSING);
  const task = reportedTask(call, found);
  call.metrics.count("do.request", { class: "RunDO", method: "appendLog" });
  return fromRun(call, "log append", () =>
    call.env.RUN.getByName(task.runId).appendLog(task.id, bytes, truncated, found.runner.id),
  );
}
