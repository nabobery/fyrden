// The runner's side of the runner protocol: the requests a runner encodes and
// the responses it decodes, so the server's codecs can be checked in round trips.
import {
  type DeclareRequest,
  decodeTaskState,
  encodeTaskState,
  encodeTimestamp,
  type FetchTaskRequest,
  type FetchTaskResponse,
  type JsonObject,
  type JsonValue,
  type LogRow,
  type PingRequest,
  type PingResponse,
  type RegisterRequest,
  type Runner,
  readStringMapEntry,
  type Task,
  type TaskNeed,
  type UpdateLogResponse,
  type UpdateTaskRequest,
  type UpdateTaskResponse,
  writeStringMap,
} from "../../src/runner/proto/messages.js";
import { fieldKey, readFields, WireType, Writer } from "../../src/runner/proto/wire.js";

const { Varint, Fixed64, Bytes } = WireType;

export interface UpdateLogRequestInput {
  taskId: number;
  index: number;
  rows: LogRow[];
  noMore: boolean;
}

export function encodePingRequest(request: PingRequest): Uint8Array {
  return new Writer().string(1, request.data).finish();
}

export function decodePingResponse(bytes: Uint8Array): PingResponse {
  let data = "";
  readFields(bytes, (r, key) => {
    if (key !== fieldKey(1, Bytes)) return false;
    data = r.string();
    return true;
  });
  return { data };
}

export function encodeRegisterRequest(request: RegisterRequest): Uint8Array {
  const w = new Writer().string(1, request.name).string(2, request.token);
  for (const label of request.agentLabels) w.string(3, label, true);
  for (const label of request.customLabels) w.string(4, label, true);
  w.string(5, request.version);
  for (const label of request.labels) w.string(6, label, true);
  w.bool(7, request.ephemeral);
  for (const capability of request.capabilities) w.string(8, capability, true);
  return w.finish();
}

export function encodeDeclareRequest(request: DeclareRequest): Uint8Array {
  const w = new Writer().string(1, request.version);
  for (const label of request.labels) w.string(2, label, true);
  for (const capability of request.capabilities) w.string(3, capability, true);
  return w.finish();
}

/** RegisterResponse and DeclareResponse: field 1 is the runner. */
export function decodeRunnerResponse(bytes: Uint8Array): { runner?: Runner } {
  const response: { runner?: Runner } = {};
  readFields(bytes, (r, key) => {
    if (key !== fieldKey(1, Bytes)) return false;
    response.runner = decodeRunner(r.bytes());
    return true;
  });
  return response;
}

function decodeRunner(bytes: Uint8Array): Runner {
  const runner: Runner = {
    id: 0,
    uuid: "",
    token: "",
    name: "",
    status: 0,
    agentLabels: [],
    customLabels: [],
    version: "",
    labels: [],
    ephemeral: false,
  };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Varint):
        runner.id = r.uint64();
        return true;
      case fieldKey(2, Bytes):
        runner.uuid = r.string();
        return true;
      case fieldKey(3, Bytes):
        runner.token = r.string();
        return true;
      case fieldKey(4, Bytes):
        runner.name = r.string();
        return true;
      case fieldKey(5, Varint):
        runner.status = r.int32();
        return true;
      case fieldKey(6, Bytes):
        runner.agentLabels.push(r.string());
        return true;
      case fieldKey(7, Bytes):
        runner.customLabels.push(r.string());
        return true;
      case fieldKey(8, Bytes):
        runner.version = r.string();
        return true;
      case fieldKey(9, Bytes):
        runner.labels.push(r.string());
        return true;
      case fieldKey(10, Varint):
        runner.ephemeral = r.bool();
        return true;
      default:
        return false;
    }
  });
  return runner;
}

export function encodeFetchTaskRequest(request: FetchTaskRequest): Uint8Array {
  return new Writer().uint64(1, request.tasksVersion).finish();
}

export function decodeFetchTaskResponse(bytes: Uint8Array): FetchTaskResponse {
  const response: FetchTaskResponse = { tasksVersion: 0 };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        response.task = decodeTask(r.bytes());
        return true;
      case fieldKey(2, Varint):
        response.tasksVersion = r.uint64();
        return true;
      default:
        return false;
    }
  });
  return response;
}

function decodeTask(bytes: Uint8Array): Task {
  const task: Task = {
    id: 0,
    secrets: new Map(),
    machine: "",
    needs: new Map(),
    vars: new Map(),
  };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Varint):
        task.id = r.uint64();
        return true;
      case fieldKey(2, Bytes):
        task.workflowPayload = r.bytes().slice();
        return true;
      case fieldKey(3, Bytes):
        task.context = decodeStruct(r.bytes());
        return true;
      case fieldKey(4, Bytes):
        task.secrets.set(...readStringMapEntry(r.bytes()));
        return true;
      case fieldKey(5, Bytes):
        task.machine = r.string();
        return true;
      case fieldKey(6, Bytes):
        task.needs.set(...decodeNeedEntry(r.bytes()));
        return true;
      case fieldKey(7, Bytes):
        task.vars.set(...readStringMapEntry(r.bytes()));
        return true;
      default:
        return false;
    }
  });
  return task;
}

function decodeNeedEntry(bytes: Uint8Array): [string, TaskNeed] {
  let name = "";
  const need: TaskNeed = { outputs: new Map(), result: 0 };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        name = r.string();
        return true;
      case fieldKey(2, Bytes): {
        need.outputs = new Map();
        need.result = 0;
        readFields(r.bytes(), (nr, nkey) => {
          switch (nkey) {
            case fieldKey(1, Bytes):
              need.outputs.set(...readStringMapEntry(nr.bytes()));
              return true;
            case fieldKey(2, Varint):
              need.result = nr.int32();
              return true;
            default:
              return false;
          }
        });
        return true;
      }
      default:
        return false;
    }
  });
  return [name, need];
}

export function decodeStruct(bytes: Uint8Array): JsonObject {
  const entries: [string, JsonValue][] = [];
  readFields(bytes, (r, key) => {
    if (key !== fieldKey(1, Bytes)) return false;
    let name = "";
    let value: JsonValue = null;
    readFields(r.bytes(), (er, ekey) => {
      switch (ekey) {
        case fieldKey(1, Bytes):
          name = er.string();
          return true;
        case fieldKey(2, Bytes):
          value = decodeValue(er.bytes());
          return true;
        default:
          return false;
      }
    });
    entries.push([name, value]);
    return true;
  });
  return Object.fromEntries(entries);
}

function decodeValue(bytes: Uint8Array): JsonValue {
  let value: JsonValue = null;
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Varint):
        r.int32();
        value = null;
        return true;
      case fieldKey(2, Fixed64):
        value = r.double();
        return true;
      case fieldKey(3, Bytes):
        value = r.string();
        return true;
      case fieldKey(4, Varint):
        value = r.bool();
        return true;
      case fieldKey(5, Bytes):
        value = decodeStruct(r.bytes());
        return true;
      case fieldKey(6, Bytes): {
        const list: JsonValue[] = [];
        readFields(r.bytes(), (lr, lkey) => {
          if (lkey !== fieldKey(1, Bytes)) return false;
          list.push(decodeValue(lr.bytes()));
          return true;
        });
        value = list;
        return true;
      }
      default:
        return false;
    }
  });
  return value;
}

export function encodeUpdateTaskRequest(request: UpdateTaskRequest): Uint8Array {
  const w = new Writer();
  if (request.state) w.message(1, encodeTaskState(request.state));
  writeStringMap(w, 2, request.outputs);
  return w.finish();
}

export function decodeUpdateTaskResponse(bytes: Uint8Array): UpdateTaskResponse {
  const response: UpdateTaskResponse = { sentOutputs: [] };
  readFields(bytes, (r, key) => {
    switch (key) {
      case fieldKey(1, Bytes):
        response.state = decodeTaskState(r.bytes());
        return true;
      case fieldKey(2, Bytes):
        response.sentOutputs.push(r.string());
        return true;
      default:
        return false;
    }
  });
  return response;
}

export function encodeLogRow(row: LogRow): Uint8Array {
  const w = new Writer();
  if (row.time) w.message(1, encodeTimestamp(row.time));
  return w.string(2, row.content).finish();
}

export function encodeUpdateLogRequest(request: Partial<UpdateLogRequestInput>): Uint8Array {
  const w = new Writer().uint64(1, request.taskId ?? 0).uint64(2, request.index ?? 0);
  for (const row of request.rows ?? []) w.message(3, encodeLogRow(row));
  return w.bool(4, request.noMore ?? false).finish();
}

export function decodeUpdateLogResponse(bytes: Uint8Array): UpdateLogResponse {
  let ackIndex = 0;
  readFields(bytes, (r, key) => {
    if (key !== fieldKey(1, Varint)) return false;
    ackIndex = r.uint64();
    return true;
  });
  return { ackIndex };
}
