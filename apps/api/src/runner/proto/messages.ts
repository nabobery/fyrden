// The runner protocol's messages, `runner.v1` and `ping.v1`. Field numbers are
// from gitea.dev/actionslib v1.5.2, the module both pinned runners link:
// runner/v1/messages.pb.go and ping/v1/messages.pb.go at tag v1.5.2
// (verified: https://gitea.com/gitea/actionslib/src/tag/v1.5.2/runner/v1/messages.pb.go).
//
// The server decodes requests and encodes responses, so each message has the
// direction the server needs; TaskState goes both ways. A singular embedded
// message that occurs twice is replaced, not merged as protobuf would merge
// it (unverified that no runner repeats one: Go's generated marshaller writes
// each singular field once).
import { decodeUtf8, fieldKey, ProtoError, Reader, readFields, WireType, Writer } from "./wire.js";

const { Varint, Bytes } = WireType;

/** `runner.v1.Result`. Enums are open: a value not listed here is kept as a number. */
export const Result = { UNSPECIFIED: 0, SUCCESS: 1, FAILURE: 2, CANCELLED: 3, SKIPPED: 4 } as const;

/** `runner.v1.RunnerStatus`. */
export const RunnerStatus = { UNSPECIFIED: 0, IDLE: 1, ACTIVE: 2, OFFLINE: 3 } as const;

/** `runner.v1.StepStage`, set only in a TaskState's reported steps. */
export const StepStage = {
  UNSPECIFIED: 0,
  SETUP: 1,
  INIT_CONTAINERS: 2,
  PRE: 3,
  MAIN: 4,
  POST: 5,
  STOP_CONTAINERS: 6,
  CLEANUP: 7,
} as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** `google.protobuf.Timestamp`. */
export interface Timestamp {
  seconds: number;
  nanos: number;
}

export interface PingRequest {
  data: string;
}

export interface PingResponse {
  data: string;
}

export interface RegisterRequest {
  name: string;
  token: string;
  agentLabels: string[];
  customLabels: string[];
  version: string;
  labels: string[];
  ephemeral: boolean;
  capabilities: string[];
}

export interface Runner {
  id: number;
  uuid: string;
  token: string;
  name: string;
  status: number;
  agentLabels: string[];
  customLabels: string[];
  version: string;
  labels: string[];
  ephemeral: boolean;
}

export interface RegisterResponse {
  runner: Runner;
}

export interface DeclareRequest {
  version: string;
  labels: string[];
  capabilities: string[];
}

export interface DeclareResponse {
  runner: Runner;
}

export interface FetchTaskRequest {
  tasksVersion: number;
}

export interface TaskNeed {
  outputs: Map<string, string>;
  result: number;
}

export interface Task {
  id: number;
  /** An optional field: written when set, even empty. */
  workflowPayload?: Uint8Array;
  /** The `github` context, as a `google.protobuf.Struct`. */
  context?: JsonObject;
  secrets: Map<string, string>;
  machine: string;
  needs: Map<string, TaskNeed>;
  vars: Map<string, string>;
}

export interface FetchTaskResponse {
  task?: Task;
  tasksVersion: number;
}

export interface StepState {
  id: number;
  result: number;
  startedAt?: Timestamp;
  stoppedAt?: Timestamp;
  logIndex: number;
  logLength: number;
  name: string;
  stage: number;
  number: number;
}

export interface TaskState {
  id: number;
  result: number;
  startedAt?: Timestamp;
  stoppedAt?: Timestamp;
  steps: StepState[];
  reportedSteps: StepState[];
}

export interface UpdateTaskRequest {
  state?: TaskState;
  outputs: Map<string, string>;
}

export interface UpdateTaskResponse {
  state?: TaskState;
  sentOutputs: string[];
}

export interface LogRow {
  time?: Timestamp;
  content: string;
}

export interface UpdateLogRequest {
  taskId: number;
  index: number;
  rows: LogRow[];
  noMore: boolean;
}

export interface UpdateLogResponse {
  ackIndex: number;
}

// ---- shared pieces ----

export function decodeTimestamp(bytes: Uint8Array): Timestamp {
  const ts: Timestamp = { seconds: 0, nanos: 0 };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Varint):
        ts.seconds = r.int64();
        return true;
      case fieldKey(2, Varint):
        ts.nanos = r.int32();
        return true;
      default:
        return false;
    }
  });
  return ts;
}

export function encodeTimestamp(ts: Timestamp): Uint8Array {
  return new Writer().int64(1, ts.seconds).int32(2, ts.nanos).finish();
}

/** One entry of a `map<string, string>`: key field 1, value field 2. */
export function readStringMapEntry(bytes: Uint8Array): [string, string] {
  let name = "";
  let value = "";
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        name = r.string();
        return true;
      case fieldKey(2, Bytes):
        value = r.string();
        return true;
      default:
        return false;
    }
  });
  return [name, value];
}

/** A `map<string, string>`: one entry message per key, key and value both written. */
export function writeStringMap(w: Writer, field: number, map: ReadonlyMap<string, string>): void {
  for (const [name, value] of map) {
    w.message(field, new Writer().string(1, name, true).string(2, value, true).finish());
  }
}

function decodeStepState(bytes: Uint8Array): StepState {
  const step: StepState = {
    id: 0,
    result: 0,
    logIndex: 0,
    logLength: 0,
    name: "",
    stage: 0,
    number: 0,
  };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Varint):
        step.id = r.uint64();
        return true;
      case fieldKey(2, Varint):
        step.result = r.int32();
        return true;
      case fieldKey(3, Bytes):
        step.startedAt = decodeTimestamp(r.bytes());
        return true;
      case fieldKey(4, Bytes):
        step.stoppedAt = decodeTimestamp(r.bytes());
        return true;
      case fieldKey(5, Varint):
        step.logIndex = r.uint64();
        return true;
      case fieldKey(6, Varint):
        step.logLength = r.uint64();
        return true;
      case fieldKey(7, Bytes):
        step.name = r.string();
        return true;
      case fieldKey(8, Varint):
        step.stage = r.int32();
        return true;
      case fieldKey(9, Varint):
        step.number = r.uint64();
        return true;
      default:
        return false;
    }
  });
  return step;
}

function encodeStepState(step: StepState): Uint8Array {
  const w = new Writer().uint64(1, step.id).int32(2, step.result);
  if (step.startedAt) w.message(3, encodeTimestamp(step.startedAt));
  if (step.stoppedAt) w.message(4, encodeTimestamp(step.stoppedAt));
  return w
    .uint64(5, step.logIndex)
    .uint64(6, step.logLength)
    .string(7, step.name)
    .int32(8, step.stage)
    .uint64(9, step.number)
    .finish();
}

export function decodeTaskState(bytes: Uint8Array): TaskState {
  const state: TaskState = { id: 0, result: 0, steps: [], reportedSteps: [] };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Varint):
        state.id = r.uint64();
        return true;
      case fieldKey(2, Varint):
        state.result = r.int32();
        return true;
      case fieldKey(3, Bytes):
        state.startedAt = decodeTimestamp(r.bytes());
        return true;
      case fieldKey(4, Bytes):
        state.stoppedAt = decodeTimestamp(r.bytes());
        return true;
      case fieldKey(5, Bytes):
        state.steps.push(decodeStepState(r.bytes()));
        return true;
      case fieldKey(6, Bytes):
        state.reportedSteps.push(decodeStepState(r.bytes()));
        return true;
      default:
        return false;
    }
  });
  return state;
}

export function encodeTaskState(state: TaskState): Uint8Array {
  const w = new Writer().uint64(1, state.id).int32(2, state.result);
  if (state.startedAt) w.message(3, encodeTimestamp(state.startedAt));
  if (state.stoppedAt) w.message(4, encodeTimestamp(state.stoppedAt));
  for (const step of state.steps) w.message(5, encodeStepState(step));
  for (const step of state.reportedSteps) w.message(6, encodeStepState(step));
  return w.finish();
}

/** `google.protobuf.Struct`: `fields` (1) is a map of `Value`. */
export function encodeStruct(object: JsonObject): Uint8Array {
  const w = new Writer();
  for (const [name, value] of Object.entries(object)) {
    w.message(1, new Writer().string(1, name, true).message(2, encodeValue(value)).finish());
  }
  return w.finish();
}

/** `google.protobuf.Value`: its kind is a oneof, so a default is still written. */
function encodeValue(value: JsonValue): Uint8Array {
  const w = new Writer();
  if (value === null) w.int32(1, 0, true);
  else if (typeof value === "number") w.double(2, value, true);
  else if (typeof value === "string") w.string(3, value, true);
  else if (typeof value === "boolean") w.bool(4, value, true);
  else if (Array.isArray(value)) {
    const list = new Writer();
    for (const item of value) list.message(1, encodeValue(item));
    w.message(6, list.finish());
  } else w.message(5, encodeStruct(value));
  return w.finish();
}

function writeRunner(runner: Runner): Uint8Array {
  const w = new Writer()
    .uint64(1, runner.id)
    .string(2, runner.uuid)
    .string(3, runner.token)
    .string(4, runner.name)
    .int32(5, runner.status);
  for (const label of runner.agentLabels) w.string(6, label, true);
  for (const label of runner.customLabels) w.string(7, label, true);
  w.string(8, runner.version);
  for (const label of runner.labels) w.string(9, label, true);
  return w.bool(10, runner.ephemeral).finish();
}

function encodeTask(task: Task): Uint8Array {
  const w = new Writer().uint64(1, task.id);
  if (task.workflowPayload) w.bytes(2, task.workflowPayload, true);
  if (task.context) w.message(3, encodeStruct(task.context));
  writeStringMap(w, 4, task.secrets);
  w.string(5, task.machine);
  for (const [name, need] of task.needs) {
    const value = new Writer();
    writeStringMap(value, 1, need.outputs);
    value.int32(2, need.result);
    w.message(6, new Writer().string(1, name, true).message(2, value.finish()).finish());
  }
  writeStringMap(w, 7, task.vars);
  return w.finish();
}

// ---- ping.v1.PingService ----

export function decodePingRequest(bytes: Uint8Array): PingRequest {
  let data = "";
  readFields(bytes, (r, key) => {
    if (key !== fieldKey(1, Bytes)) return false;
    data = r.string();
    return true;
  });
  return { data };
}

export function encodePingResponse(response: PingResponse): Uint8Array {
  return new Writer().string(1, response.data).finish();
}

// ---- runner.v1.RunnerService ----

export function decodeRegisterRequest(bytes: Uint8Array): RegisterRequest {
  const request: RegisterRequest = {
    name: "",
    token: "",
    agentLabels: [],
    customLabels: [],
    version: "",
    labels: [],
    ephemeral: false,
    capabilities: [],
  };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        request.name = r.string();
        return true;
      case fieldKey(2, Bytes):
        request.token = r.string();
        return true;
      case fieldKey(3, Bytes):
        request.agentLabels.push(r.string());
        return true;
      case fieldKey(4, Bytes):
        request.customLabels.push(r.string());
        return true;
      case fieldKey(5, Bytes):
        request.version = r.string();
        return true;
      case fieldKey(6, Bytes):
        request.labels.push(r.string());
        return true;
      case fieldKey(7, Varint):
        request.ephemeral = r.bool();
        return true;
      case fieldKey(8, Bytes):
        request.capabilities.push(r.string());
        return true;
      default:
        return false;
    }
  });
  return request;
}

export function encodeRegisterResponse(response: RegisterResponse): Uint8Array {
  return new Writer().message(1, writeRunner(response.runner)).finish();
}

export function decodeDeclareRequest(bytes: Uint8Array): DeclareRequest {
  const request: DeclareRequest = { version: "", labels: [], capabilities: [] };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        request.version = r.string();
        return true;
      case fieldKey(2, Bytes):
        request.labels.push(r.string());
        return true;
      case fieldKey(3, Bytes):
        request.capabilities.push(r.string());
        return true;
      default:
        return false;
    }
  });
  return request;
}

export function encodeDeclareResponse(response: DeclareResponse): Uint8Array {
  return new Writer().message(1, writeRunner(response.runner)).finish();
}

export function decodeFetchTaskRequest(bytes: Uint8Array): FetchTaskRequest {
  let tasksVersion = 0;
  readFields(bytes, (r, key) => {
    if (key !== fieldKey(1, Varint)) return false;
    tasksVersion = r.uint64();
    return true;
  });
  return { tasksVersion };
}

export function encodeFetchTaskResponse(response: FetchTaskResponse): Uint8Array {
  const w = new Writer();
  if (response.task) w.message(1, encodeTask(response.task));
  return w.uint64(2, response.tasksVersion).finish();
}

export function decodeUpdateTaskRequest(bytes: Uint8Array): UpdateTaskRequest {
  const request: UpdateTaskRequest = { outputs: new Map() };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        request.state = decodeTaskState(r.bytes());
        return true;
      case fieldKey(2, Bytes):
        request.outputs.set(...readStringMapEntry(r.bytes()));
        return true;
      default:
        return false;
    }
  });
  return request;
}

export function encodeUpdateTaskResponse(response: UpdateTaskResponse): Uint8Array {
  const w = new Writer();
  if (response.state) w.message(1, encodeTaskState(response.state));
  for (const name of response.sentOutputs) w.string(2, name, true);
  return w.finish();
}

export const UPDATE_LOG_MAX_ROWS = 10_000;
export const UPDATE_LOG_MAX_CONTENT_BYTES = 4 * 1024 * 1024;

export interface UpdateLogDecodeOptions {
  /** The bytes are a prefix of a longer body: a field cut off at the end is dropped. */
  truncated?: boolean;
  maxRows?: number;
  /** The rows' content, counted in UTF-8 bytes. */
  maxContentBytes?: number;
}

export interface DecodedUpdateLog extends UpdateLogRequest {
  /**
   * Every row of the request is in `rows`: false when the body was a
   * truncated prefix or a cap stopped taking rows. Rows are always a
   * contiguous run from `index`; after the first row left out, none is taken.
   */
  whole: boolean;
}

/**
 * An UpdateLog request, bounded: at most `maxRows` rows and `maxContentBytes`
 * of content. Past a cap the remaining fields are still read (row bodies
 * skipped, not decoded), so `no_more` is seen wherever it is written.
 */
export function decodeUpdateLogRequest(
  bytes: Uint8Array,
  options: UpdateLogDecodeOptions = {},
): DecodedUpdateLog {
  const truncated = options.truncated ?? false;
  const maxRows = options.maxRows ?? UPDATE_LOG_MAX_ROWS;
  const maxContentBytes = options.maxContentBytes ?? UPDATE_LOG_MAX_CONTENT_BYTES;
  const result: DecodedUpdateLog = {
    taskId: 0,
    index: 0,
    rows: [],
    noMore: false,
    whole: !truncated,
  };
  let contentBytes = 0;
  let capped = false;
  const r = new Reader(bytes);
  while (!r.done) {
    let rowBody: Uint8Array | undefined;
    try {
      const { field, wire } = r.tag();
      const key = fieldKey(field, wire);
      if (key === fieldKey(1, Varint)) result.taskId = r.uint64();
      else if (key === fieldKey(2, Varint)) result.index = r.uint64();
      else if (key === fieldKey(3, Bytes)) rowBody = r.bytes();
      else if (key === fieldKey(4, Varint)) result.noMore = r.bool();
      else r.skip(wire);
    } catch (error) {
      // Only the top-level field the prefix ends in; a complete row that is malformed still throws.
      if (truncated && error instanceof ProtoError && error.endOfInput) break;
      throw error;
    }
    if (rowBody === undefined || capped) continue;
    const row = result.rows.length < maxRows ? decodeLogRow(rowBody) : undefined;
    if (row === undefined || contentBytes + row.contentBytes > maxContentBytes) {
      capped = true;
      result.whole = false;
      continue;
    }
    contentBytes += row.contentBytes;
    result.rows.push(row.row);
  }
  return result;
}

function decodeLogRow(bytes: Uint8Array): { row: LogRow; contentBytes: number } {
  const row: LogRow = { content: "" };
  let contentBytes = 0;
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        row.time = decodeTimestamp(r.bytes());
        return true;
      case fieldKey(2, Bytes): {
        const raw = r.bytes();
        row.content = decodeUtf8(raw);
        contentBytes = raw.length;
        return true;
      }
      default:
        return false;
    }
  });
  return { row, contentBytes };
}

export function encodeUpdateLogResponse(response: UpdateLogResponse): Uint8Array {
  return new Writer().uint64(1, response.ackIndex).finish();
}

const SCAN_FIELD_LIMIT = 64;

/**
 * The task id of an UpdateLog (field 1) or UpdateTask (field 1's field 1)
 * request, read without decoding rows or steps: the first such field among
 * the first 64 fields, else undefined. Bounded by that constant, not by the
 * body's size. The runners write field 1 first (unverified for every body:
 * Go's generated marshaller writes fields in number order, and the recorded
 * UpdateTask bodies follow it).
 */
export function scanTaskId(
  bytes: Uint8Array,
  kind: "update_log" | "update_task",
): number | undefined {
  if (kind === "update_log") return scanField1(bytes, Varint);
  const state = scanField1(bytes, Bytes);
  return state === undefined ? undefined : scanField1(state, Varint);
}

function scanField1(bytes: Uint8Array, wire: typeof Varint): number | undefined;
function scanField1(bytes: Uint8Array, wire: typeof Bytes): Uint8Array | undefined;
function scanField1(
  bytes: Uint8Array,
  wire: typeof Varint | typeof Bytes,
): number | Uint8Array | undefined {
  const r = new Reader(bytes);
  for (let seen = 0; seen < SCAN_FIELD_LIMIT && !r.done; seen++) {
    const tag = r.tag();
    if (tag.field === 1 && tag.wire === wire) return wire === Varint ? r.uint64() : r.bytes();
    r.skip(tag.wire);
  }
  return undefined;
}
