// The runner protocol's messages: round trips, bodies shaped as the pinned
// runners send them, and the reader's bounds on malformed input.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeDeclareRequest,
  decodeFetchTaskRequest,
  decodePingRequest,
  decodeRegisterRequest,
  decodeTaskState,
  decodeUpdateLogRequest,
  decodeUpdateTaskRequest,
  encodeDeclareResponse,
  encodeFetchTaskResponse,
  encodePingResponse,
  encodeRegisterResponse,
  encodeStruct,
  encodeTaskState,
  encodeUpdateLogResponse,
  encodeUpdateTaskResponse,
  type FetchTaskResponse,
  type JsonObject,
  type LogRow,
  Result,
  type Runner,
  type StepState,
  scanTaskId,
  type Task,
  type TaskNeed,
  type TaskState,
  type Timestamp,
  UPDATE_LOG_MAX_CONTENT_BYTES,
  UPDATE_LOG_MAX_ROWS,
  type UpdateTaskRequest,
  type UpdateTaskResponse,
} from "../src/runner/proto/messages.js";
import { ProtoError, Reader, Writer } from "../src/runner/proto/wire.js";
import {
  decodeFetchTaskResponse,
  decodePingResponse,
  decodeRunnerResponse,
  decodeUpdateLogResponse,
  decodeUpdateTaskResponse,
  encodeDeclareRequest,
  encodeFetchTaskRequest,
  encodeLogRow,
  encodePingRequest,
  encodeRegisterRequest,
  encodeUpdateLogRequest,
  encodeUpdateTaskRequest,
} from "./helpers/runner-proto.js";

// Hand-built bodies: written byte by byte, independent of the module's writer.
const utf8 = new TextEncoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

type Part = number | number[] | string | Uint8Array;

function bytes(...parts: Part[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") out.push(part);
    else for (const byte of typeof part === "string" ? utf8.encode(part) : part) out.push(byte);
  }
  return Uint8Array.from(out);
}

/** A length-delimited field: its tag byte, the length, the content. */
function ld(tag: number, ...parts: Part[]): Uint8Array {
  const content = bytes(...parts);
  return bytes(tag, varint(content.length), content);
}

/** A varint field: its tag byte and the value. */
function vi(tag: number, value: number): Uint8Array {
  return bytes(tag, varint(value));
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  return bytes(...chunks);
}

const SECONDS = 1_794_554_407;
const ts = (nanos: number) => bytes(vi(0x08, SECONDS), vi(0x10, nanos));
const at = (nanos: number): Timestamp => ({ seconds: SECONDS, nanos });

const CONTAINER = "8ca1ffd3dd590c716db55188de253635915e0cabd0729867d0f0f4a9b3e86c09";

function expectProtoError(run: () => unknown): void {
  expect(run).toThrow(ProtoError);
}

/** Runs `decode`; anything thrown must be a ProtoError. */
function onlyProtoErrors(decode: () => unknown): void {
  try {
    decode();
  } catch (error) {
    if (!(error instanceof ProtoError)) throw error;
  }
}

describe("bodies as the pinned runners send them", () => {
  it.each(["6.0.0", "5.4.1"])("Ping from v%s", (version) => {
    const body = ld(0x0a, `probe-${version}`);
    expect(body.length).toBe(13);
    expect(decodePingRequest(body)).toEqual({ data: `probe-${version}` });
  });

  it.each(["6.0.0", "5.4.1"])("Register from v%s", (version) => {
    const body = concat(
      ld(0x0a, `probe-${version}`),
      ld(0x12, "probe-registration-token"),
      ld(0x2a, `v${version}`),
      ld(0x32, "ubuntu-latest"),
      ld(0x42, "cancelling"),
    );
    expect(body.length).toBe(74);
    expect(decodeRegisterRequest(body)).toEqual({
      name: `probe-${version}`,
      token: "probe-registration-token",
      agentLabels: [],
      customLabels: [],
      version: `v${version}`,
      labels: ["ubuntu-latest"],
      ephemeral: false,
      capabilities: ["cancelling"],
    });
  });

  it("Register asking for an ephemeral runner", () => {
    const body = concat(ld(0x0a, "once"), ld(0x12, "t"), ld(0x2a, "v6.0.0"), vi(0x38, 1));
    expect(decodeRegisterRequest(body).ephemeral).toBe(true);
  });

  it.each(["6.0.0", "5.4.1"])("Declare from v%s", (version) => {
    const body = concat(ld(0x0a, `v${version}`), ld(0x12, "ubuntu-latest"), ld(0x1a, "cancelling"));
    expect(body.length).toBe(35);
    expect(decodeDeclareRequest(body)).toEqual({
      version: `v${version}`,
      labels: ["ubuntu-latest"],
      capabilities: ["cancelling"],
    });
  });

  it("FetchTask: the first poll is an empty body, later ones carry the last tasks_version", () => {
    expect(decodeFetchTaskRequest(new Uint8Array(0))).toEqual({ tasksVersion: 0 });
    expect(decodeFetchTaskRequest(vi(0x08, 2))).toEqual({ tasksVersion: 2 });
  });

  it("UpdateTask mid-job from v6.0.0, with its reported steps", () => {
    const body = ld(
      0x0a,
      vi(0x08, 1),
      ld(0x1a, ts(411_054_547)),
      ld(0x2a, ld(0x1a, ts(608_607_964))),
      ld(0x2a, vi(0x08, 1)),
      ld(
        0x32,
        vi(0x10, 1),
        ld(0x1a, ts(403_646_714)),
        ld(0x22, ts(608_607_964)),
        vi(0x30, 37),
        ld(0x3a, "Set up job"),
        vi(0x40, 1),
      ),
      ld(
        0x32,
        vi(0x08, 1),
        ld(0x1a, ts(608_607_964)),
        vi(0x28, 37),
        vi(0x30, 12),
        ld(0x3a, "hello"),
        vi(0x40, 4),
      ),
      ld(0x32, vi(0x08, 2), ld(0x3a, "count"), vi(0x40, 4), vi(0x48, 1)),
      ld(0x32, vi(0x08, 3), ld(0x3a, "Complete job"), vi(0x40, 7)),
    );
    expect(body.length).toBe(153);
    const step = (overrides: Partial<StepState>): StepState => ({
      id: 0,
      result: 0,
      logIndex: 0,
      logLength: 0,
      name: "",
      stage: 0,
      number: 0,
      ...overrides,
    });
    expect(decodeUpdateTaskRequest(body)).toEqual({
      state: {
        id: 1,
        result: Result.UNSPECIFIED,
        startedAt: at(411_054_547),
        steps: [step({ startedAt: at(608_607_964) }), step({ id: 1 })],
        reportedSteps: [
          step({
            result: Result.SUCCESS,
            startedAt: at(403_646_714),
            stoppedAt: at(608_607_964),
            logLength: 37,
            name: "Set up job",
            stage: 1,
          }),
          step({
            id: 1,
            startedAt: at(608_607_964),
            logIndex: 37,
            logLength: 12,
            name: "hello",
            stage: 4,
          }),
          step({ id: 2, name: "count", stage: 4, number: 1 }),
          step({ id: 3, name: "Complete job", stage: 7 }),
        ],
      },
      outputs: new Map(),
    });
  });

  it("the final UpdateTask: a result, stopped_at and the job's outputs", () => {
    const body = concat(
      ld(0x0a, vi(0x08, 1), vi(0x10, 1), ld(0x22, ts(900_000_000))),
      ld(0x12, ld(0x0a, "answer"), ld(0x12, "42")),
    );
    expect(decodeUpdateTaskRequest(body)).toEqual({
      state: {
        id: 1,
        result: Result.SUCCESS,
        stoppedAt: at(900_000_000),
        steps: [],
        reportedSteps: [],
      },
      outputs: new Map([["answer", "42"]]),
    });
  });

  it("the final UpdateLog with trailing rows (139 bytes)", () => {
    const body = concat(
      vi(0x08, 5),
      vi(0x10, 150),
      ld(0x1a, ld(0x0a, ts(300_000_000)), ld(0x12, `Removed container: ${CONTAINER}`)),
      ld(0x1a, ld(0x0a, ts(300_100_000)), ld(0x12, "Job succeeded")),
      vi(0x20, 1),
    );
    expect(body.length).toBe(139);
    expect(decodeUpdateLogRequest(body)).toEqual({
      taskId: 5,
      index: 150,
      rows: [
        { time: at(300_000_000), content: `Removed container: ${CONTAINER}` },
        { time: at(300_100_000), content: "Job succeeded" },
      ],
      noMore: true,
      whole: true,
    });
    expect(scanTaskId(body, "update_log")).toBe(5);
  });

  it("v6.0.0's final UpdateLog with nothing left: no_more and zero rows (7 bytes)", () => {
    const body = concat(vi(0x08, 7), vi(0x10, 152), vi(0x20, 1));
    expect(body.length).toBe(7);
    expect(decodeUpdateLogRequest(body)).toEqual({
      taskId: 7,
      index: 152,
      rows: [],
      noMore: true,
      whole: true,
    });
  });

  it("v5.4.1's final UpdateLog with nothing left: one row with empty content (23 bytes)", () => {
    const body = concat(
      vi(0x08, 48),
      vi(0x10, 152),
      ld(0x1a, ld(0x0a, ts(512_000_000))),
      vi(0x20, 1),
    );
    expect(body.length).toBe(23);
    expect(decodeUpdateLogRequest(body)).toEqual({
      taskId: 48,
      index: 152,
      rows: [{ time: at(512_000_000), content: "" }],
      noMore: true,
      whole: true,
    });
  });
});

describe("what the server writes", () => {
  it("omits proto3 defaults", () => {
    expect(encodePingResponse({ data: "" })).toEqual(new Uint8Array(0));
    expect(encodeUpdateLogResponse({ ackIndex: 0 })).toEqual(new Uint8Array(0));
    expect(encodeFetchTaskResponse({ tasksVersion: 0 })).toEqual(new Uint8Array(0));
    expect(encodeUpdateTaskResponse({ sentOutputs: [] })).toEqual(new Uint8Array(0));
    expect(encodeUpdateLogResponse({ ackIndex: 152 })).toEqual(vi(0x08, 152));
  });

  it("writes a task's workflow payload when present, even empty, as its optional field requires", () => {
    const task: Task = {
      id: 1,
      workflowPayload: new Uint8Array(0),
      secrets: new Map(),
      machine: "",
      needs: new Map(),
      vars: new Map(),
    };
    expect(encodeFetchTaskResponse({ task, tasksVersion: 0 })).toEqual(
      ld(0x0a, vi(0x08, 1), bytes(0x12, 0x00)),
    );
  });

  it("writes every kind of a Struct value, defaults included (a Value is a oneof)", () => {
    expect(encodeStruct({ a: null, b: 0, c: "", d: false })).toEqual(
      concat(
        ld(0x0a, ld(0x0a, "a"), ld(0x12, 0x08, 0x00)),
        ld(0x0a, ld(0x0a, "b"), ld(0x12, 0x11, [0, 0, 0, 0, 0, 0, 0, 0])),
        ld(0x0a, ld(0x0a, "c"), ld(0x12, 0x1a, 0x00)),
        ld(0x0a, ld(0x0a, "d"), ld(0x12, 0x20, 0x00)),
      ),
    );
    expect(encodeStruct({ l: [true, { n: 1.5 }] })).toEqual(
      ld(
        0x0a,
        ld(0x0a, "l"),
        ld(
          0x12,
          ld(
            0x32,
            ld(0x0a, 0x20, 0x01),
            ld(
              0x0a,
              ld(0x2a, ld(0x0a, ld(0x0a, "n"), ld(0x12, 0x11, [0, 0, 0, 0, 0, 0, 0xf8, 0x3f]))),
            ),
          ),
        ),
      ),
    );
  });
});

describe("decoding rules", () => {
  it("skips unknown fields of every wire type", () => {
    const body = concat(
      vi(0x48, 300),
      bytes(0x51, [1, 2, 3, 4, 5, 6, 7, 8]),
      ld(0x0a, "kept"),
      ld(0x5a, "unknown"),
      bytes(0x65, [1, 2, 3, 4]),
    );
    expect(decodePingRequest(body)).toEqual({ data: "kept" });
  });

  it("treats a known field number with another wire type as unknown", () => {
    expect(decodePingRequest(vi(0x08, 5))).toEqual({ data: "" });
  });

  it("takes the last occurrence of a scalar and every occurrence of a repeated field", () => {
    expect(decodePingRequest(concat(ld(0x0a, "first"), ld(0x0a, "last")))).toEqual({
      data: "last",
    });
    expect(
      decodeDeclareRequest(concat(ld(0x12, "a"), ld(0x0a, "v1"), ld(0x12, "b"), ld(0x0a, "v2"))),
    ).toEqual({
      version: "v2",
      labels: ["a", "b"],
      capabilities: [],
    });
  });

  it("takes the last value of a repeated map key", () => {
    const entry = (k: string, v: string) => ld(0x12, ld(0x0a, k), ld(0x12, v));
    expect(decodeUpdateTaskRequest(concat(entry("k", "1"), entry("k", "2"))).outputs).toEqual(
      new Map([["k", "2"]]),
    );
  });

  it("keeps a leading byte order mark, which is part of the string", () => {
    expect(decodePingRequest(ld(0x0a, 0xef, 0xbb, 0xbf, "x"))).toEqual({ data: "\uFEFFx" });
  });

  it("reads ids up to the largest safe integer", () => {
    expect(decodeUpdateLogRequest(vi(0x08, Number.MAX_SAFE_INTEGER)).taskId).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("malformed input is a ProtoError", () => {
  it.each([
    ["a varint longer than ten bytes", bytes(0x08, Array(10).fill(0x80), 0x00)],
    ["a ten-byte varint overflowing 64 bits", bytes(0x08, Array(9).fill(0xff), 0x02)],
    ["a truncated varint", bytes(0x08, 0x80)],
    ["a truncated tag", bytes(0x80)],
    ["a length past the end", bytes(0x0a, 0x05, 0x61)],
    ["a huge length", bytes(0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f)],
    ["a truncated fixed64", bytes(0x09, 1, 2, 3)],
    ["a truncated fixed32", bytes(0x0d, 1, 2)],
    ["field number 0", bytes(0x00, 0x01)],
    ["field number 0, length-delimited", bytes(0x02, 0x00)],
    ["a field number above the protobuf maximum", bytes(0x80, 0x80, 0x80, 0x80, 0x10, 0x00)],
    ["wire type 3 (group start)", bytes(0x0b)],
    ["wire type 4 (group end)", bytes(0x0c)],
    ["wire type 6", bytes(0x0e, 0x00)],
    ["wire type 7", bytes(0x0f, 0x00)],
    ["invalid UTF-8", ld(0x0a, 0xff)],
    ["an overlong UTF-8 encoding", ld(0x0a, 0xc0, 0x80)],
    ["an encoded surrogate", ld(0x0a, 0xed, 0xa0, 0x80)],
  ])("%s", (_what, body) => {
    expectProtoError(() => decodePingRequest(body));
  });

  it("refuses an id above the largest safe integer, which a number cannot hold exactly", () => {
    expectProtoError(() => decodeUpdateLogRequest(vi(0x08, 2 ** 53)));
    expectProtoError(() => scanTaskId(vi(0x08, 2 ** 53), "update_log"));
  });

  it("refuses a negative id (an int64 written as a ten-byte varint)", () => {
    const minusOne = bytes(0x08, Array(9).fill(0xff), 0x01);
    expectProtoError(() => decodeUpdateLogRequest(minusOne));
    expectProtoError(() => decodeFetchTaskRequest(minusOne));
  });

  it("refuses invalid UTF-8 in a nested row", () => {
    expectProtoError(() => decodeUpdateLogRequest(ld(0x1a, ld(0x12, 0xff))));
  });

  const decoders: [string, (body: Uint8Array) => unknown][] = [
    ["Ping", decodePingRequest],
    ["Register", decodeRegisterRequest],
    ["Declare", decodeDeclareRequest],
    ["FetchTask", decodeFetchTaskRequest],
    ["UpdateTask", decodeUpdateTaskRequest],
    ["UpdateLog", (body) => decodeUpdateLogRequest(body)],
    ["UpdateLog prefix", (body) => decodeUpdateLogRequest(body, { truncated: true })],
    ["UpdateLog scan", (body) => scanTaskId(body, "update_log")],
    ["UpdateTask scan", (body) => scanTaskId(body, "update_task")],
  ];

  it.each(decoders)("%s: arbitrary bytes throw nothing but ProtoError", (_name, decode) => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (body) => onlyProtoErrors(() => decode(body))),
    );
  });

  it.each(decoders)(
    "%s: arbitrary bytes inside a valid frame throw nothing but ProtoError",
    (_name, decode) => {
      // Nests garbage where each decoder looks for a message, so nested readers see it too.
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 8 }),
          fc.uint8Array({ maxLength: 120 }),
          (field, inner) =>
            onlyProtoErrors(() => decode(concat(vi(0x08, 1), ld((field << 3) | 2, inner)))),
        ),
      );
    },
  );
});

// Arbitraries for every field.
const text = fc.string({ unit: "binary", maxLength: 12 });
const safe = fc.maxSafeNat();
const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 });
/** A record whose optional keys are sometimes absent (never present as undefined). */
const withOptional = <T>(model: { [K in keyof T]: fc.Arbitrary<T[K]> }, required: (keyof T)[]) =>
  fc.record(model, { requiredKeys: required }) as fc.Arbitrary<T>;
const timestamp: fc.Arbitrary<Timestamp> = fc.record({
  seconds: fc.integer({ min: -62_135_596_800, max: 253_402_300_799 }),
  nanos: fc.integer({ min: 0, max: 999_999_999 }),
});
const strings = fc.array(text, { maxLength: 4 });
const stringMap = fc
  .uniqueArray(fc.tuple(text, text), { selector: ([key]) => key, maxLength: 4 })
  .map((entries) => new Map(entries));
const step = withOptional<StepState>(
  {
    id: safe,
    result: int32,
    startedAt: timestamp,
    stoppedAt: timestamp,
    logIndex: safe,
    logLength: safe,
    name: text,
    stage: int32,
    number: safe,
  },
  ["id", "result", "logIndex", "logLength", "name", "stage", "number"],
);
const taskState = withOptional<TaskState>(
  {
    id: safe,
    result: int32,
    startedAt: timestamp,
    stoppedAt: timestamp,
    steps: fc.array(step, { maxLength: 3 }),
    reportedSteps: fc.array(step, { maxLength: 3 }),
  },
  ["id", "result", "steps", "reportedSteps"],
);
const runner: fc.Arbitrary<Runner> = fc.record({
  id: safe,
  uuid: text,
  token: text,
  name: text,
  status: int32,
  agentLabels: strings,
  customLabels: strings,
  version: text,
  labels: strings,
  ephemeral: fc.boolean(),
});
const jsonObject = fc.dictionary(text, fc.jsonValue({ maxDepth: 3 }), {
  maxKeys: 4,
}) as fc.Arbitrary<JsonObject>;
const need: fc.Arbitrary<TaskNeed> = fc.record({ outputs: stringMap, result: int32 });
const task = withOptional<Task>(
  {
    id: safe,
    workflowPayload: fc.uint8Array({ maxLength: 40 }),
    context: jsonObject,
    secrets: stringMap,
    machine: text,
    needs: fc
      .uniqueArray(fc.tuple(text, need), { selector: ([key]) => key, maxLength: 3 })
      .map((entries) => new Map(entries)),
    vars: stringMap,
  },
  ["id", "secrets", "machine", "needs", "vars"],
);
const row = withOptional<LogRow>({ time: timestamp, content: text }, ["content"]);
const updateLog = fc.record({
  taskId: safe,
  index: safe,
  rows: fc.array(row, { maxLength: 5 }),
  noMore: fc.boolean(),
});

describe("round trips", () => {
  it("Ping", () => {
    fc.assert(
      fc.property(text, (data) => {
        expect(decodePingRequest(encodePingRequest({ data }))).toEqual({ data });
        expect(decodePingResponse(encodePingResponse({ data }))).toEqual({ data });
      }),
    );
  });

  it("Register", () => {
    const request = fc.record({
      name: text,
      token: text,
      agentLabels: strings,
      customLabels: strings,
      version: text,
      labels: strings,
      ephemeral: fc.boolean(),
      capabilities: strings,
    });
    fc.assert(
      fc.property(request, runner, (req, res) => {
        expect(decodeRegisterRequest(encodeRegisterRequest(req))).toEqual(req);
        expect(decodeRunnerResponse(encodeRegisterResponse({ runner: res }))).toEqual({
          runner: res,
        });
      }),
    );
  });

  it("Declare", () => {
    const request = fc.record({ version: text, labels: strings, capabilities: strings });
    fc.assert(
      fc.property(request, runner, (req, res) => {
        expect(decodeDeclareRequest(encodeDeclareRequest(req))).toEqual(req);
        expect(decodeRunnerResponse(encodeDeclareResponse({ runner: res }))).toEqual({
          runner: res,
        });
      }),
    );
  });

  it("FetchTask, with a task and its context", () => {
    const response = withOptional<FetchTaskResponse>({ task, tasksVersion: safe }, [
      "tasksVersion",
    ]);
    fc.assert(
      fc.property(safe, response, (tasksVersion, res) => {
        expect(decodeFetchTaskRequest(encodeFetchTaskRequest({ tasksVersion }))).toEqual({
          tasksVersion,
        });
        expect(decodeFetchTaskResponse(encodeFetchTaskResponse(res))).toEqual(res);
      }),
    );
  });

  it("UpdateTask", () => {
    const request = withOptional<UpdateTaskRequest>({ state: taskState, outputs: stringMap }, [
      "outputs",
    ]);
    const response = withOptional<UpdateTaskResponse>({ state: taskState, sentOutputs: strings }, [
      "sentOutputs",
    ]);
    fc.assert(
      fc.property(request, response, (req, res) => {
        expect(decodeUpdateTaskRequest(encodeUpdateTaskRequest(req))).toEqual(req);
        expect(decodeUpdateTaskResponse(encodeUpdateTaskResponse(res))).toEqual(res);
      }),
    );
  });

  it("TaskState", () => {
    fc.assert(
      fc.property(taskState, (state) => {
        expect(decodeTaskState(encodeTaskState(state))).toEqual(state);
      }),
    );
  });

  it("UpdateLog", () => {
    fc.assert(
      fc.property(updateLog, safe, (request, ackIndex) => {
        expect(decodeUpdateLogRequest(encodeUpdateLogRequest(request))).toEqual({
          ...request,
          whole: true,
        });
        expect(decodeUpdateLogResponse(encodeUpdateLogResponse({ ackIndex }))).toEqual({
          ackIndex,
        });
      }),
    );
  });

  it("the wire's scalars", () => {
    fc.assert(
      fc.property(safe, fc.maxSafeInteger(), int32, fc.double(), (u, s, i, d) => {
        const r = new Reader(
          new Writer()
            .uint64(1, u, true)
            .int64(2, s, true)
            .int32(3, i, true)
            .double(4, d, true)
            .finish(),
        );
        expect(r.tag()).toEqual({ field: 1, wire: 0 });
        expect(r.uint64()).toBe(u);
        expect(r.tag()).toEqual({ field: 2, wire: 0 });
        expect(r.int64()).toBe(s);
        expect(r.tag()).toEqual({ field: 3, wire: 0 });
        expect(r.int32()).toBe(i);
        expect(r.tag()).toEqual({ field: 4, wire: 1 });
        expect(Object.is(r.double(), d)).toBe(true);
        expect(r.done).toBe(true);
      }),
    );
  });
});

describe("scanTaskId", () => {
  it("equals the full decode's task id (UpdateLog)", () => {
    fc.assert(
      fc.property(updateLog, (request) => {
        const body = encodeUpdateLogRequest(request);
        const id = decodeUpdateLogRequest(body).taskId;
        expect(scanTaskId(body, "update_log")).toBe(id === 0 ? undefined : id);
      }),
    );
  });

  it("equals the full decode's task id (UpdateTask: the state's id)", () => {
    fc.assert(
      fc.property(taskState, stringMap, (state, outputs) => {
        const body = encodeUpdateTaskRequest({ state, outputs });
        const id = decodeUpdateTaskRequest(body).state?.id ?? 0;
        expect(scanTaskId(body, "update_task")).toBe(id === 0 ? undefined : id);
      }),
    );
  });

  it("is undefined when field 1 is absent", () => {
    expect(scanTaskId(new Uint8Array(0), "update_log")).toBeUndefined();
    expect(scanTaskId(new Uint8Array(0), "update_task")).toBeUndefined();
    expect(scanTaskId(concat(vi(0x10, 4), vi(0x20, 1)), "update_log")).toBeUndefined();
    expect(scanTaskId(ld(0x12, ld(0x0a, "k")), "update_task")).toBeUndefined();
    expect(scanTaskId(ld(0x0a, vi(0x10, 1)), "update_task")).toBeUndefined();
  });

  it("takes an explicit zero as written", () => {
    expect(scanTaskId(vi(0x08, 0), "update_log")).toBe(0);
  });

  it("skips a field 1 of the wrong wire type", () => {
    expect(scanTaskId(concat(ld(0x0a, "x"), vi(0x08, 9)), "update_log")).toBe(9);
    expect(scanTaskId(concat(vi(0x08, 3), ld(0x0a, vi(0x08, 9))), "update_task")).toBe(9);
  });

  const filler = (count: number) =>
    concat(...Array.from({ length: count }, () => ld(0x1a, ld(0x12, "row"))));

  it("finds field 1 as the 64th top-level field", () => {
    expect(scanTaskId(concat(filler(63), vi(0x08, 11)), "update_log")).toBe(11);
    expect(
      scanTaskId(
        concat(ld(0x12, ld(0x0a, "k")), filler(62), ld(0x0a, vi(0x08, 11))),
        "update_task",
      ),
    ).toBe(11);
  });

  it("stops after 64 top-level fields without reading further", () => {
    // Malformed bytes after the 65th field would throw if the scan read them.
    expect(scanTaskId(concat(filler(64), vi(0x08, 11), bytes(0x0b)), "update_log")).toBeUndefined();
    expect(
      scanTaskId(concat(filler(64), ld(0x0a, vi(0x08, 11)), bytes(0x0b)), "update_task"),
    ).toBeUndefined();
  });

  it("does not decode row bodies", () => {
    const badRow = ld(0x1a, ld(0x12, 0xff));
    const body = concat(badRow, vi(0x08, 6), badRow);
    expectProtoError(() => decodeUpdateLogRequest(body));
    expect(scanTaskId(body, "update_log")).toBe(6);
  });
});

describe("decodeUpdateLogRequest bounds", () => {
  const rows = (count: number): LogRow[] =>
    Array.from({ length: count }, (_, i) => ({ time: at(i), content: `line ${i}` }));
  const rowsOnly = (list: LogRow[]) => concat(...list.map((r) => ld(0x1a, encodeLogRow(r))));

  it("defaults to 10,000 rows and 4 MiB of content", () => {
    expect(UPDATE_LOG_MAX_ROWS).toBe(10_000);
    expect(UPDATE_LOG_MAX_CONTENT_BYTES).toBe(4 * 1024 * 1024);
  });

  it("takes 10,000 rows whole", () => {
    const body = encodeUpdateLogRequest({ taskId: 3, index: 0, rows: rows(10_000), noMore: true });
    const decoded = decodeUpdateLogRequest(body);
    expect(decoded.rows.length).toBe(10_000);
    expect(decoded.whole).toBe(true);
    expect(decoded.noMore).toBe(true);
  });

  it("stops at 10,000 of 10,001 rows and still reads no_more written before them", () => {
    const body = concat(
      encodeUpdateLogRequest({ taskId: 3, index: 20, noMore: true }),
      rowsOnly(rows(10_001)),
    );
    const decoded = decodeUpdateLogRequest(body);
    expect(decoded.rows.length).toBe(10_000);
    expect(decoded.rows.at(-1)).toEqual(rows(10_000).at(-1));
    expect(decoded).toMatchObject({ taskId: 3, index: 20, noMore: true, whole: false });
  });

  it("reads no_more written after rows past the cap", () => {
    const body = concat(rowsOnly(rows(3)), vi(0x08, 4), vi(0x20, 1));
    expect(decodeUpdateLogRequest(body, { maxRows: 2 })).toMatchObject({
      taskId: 4,
      rows: rows(2),
      noMore: true,
      whole: false,
    });
  });

  it("caps content by UTF-8 bytes and keeps rows contiguous", () => {
    const list: LogRow[] = [{ content: "abc" }, { content: "def" }, { content: "g" }];
    const body = encodeUpdateLogRequest({ taskId: 1, rows: list });
    expect(decodeUpdateLogRequest(body, { maxContentBytes: 7 })).toMatchObject({
      rows: list,
      whole: true,
    });
    expect(decodeUpdateLogRequest(body, { maxContentBytes: 6 })).toMatchObject({
      rows: list.slice(0, 2),
      whole: false,
    });
    // The third row would fit after a skipped second, but rows after a gap are never taken.
    expect(decodeUpdateLogRequest(body, { maxContentBytes: 4 })).toMatchObject({
      rows: list.slice(0, 1),
      whole: false,
    });
    expect(
      decodeUpdateLogRequest(encodeUpdateLogRequest({ rows: [{ content: "é" }] }), {
        maxContentBytes: 1,
      }),
    ).toMatchObject({ rows: [], whole: false });
  });

  describe("a truncated prefix", () => {
    const sample = encodeUpdateLogRequest({
      taskId: 9,
      index: 4,
      rows: [
        { time: at(1), content: "first ✓" },
        { time: at(2), content: "" },
        { time: at(3), content: "third" },
      ],
      noMore: true,
    });
    const full = decodeUpdateLogRequest(sample);

    it("cut at every byte offset never throws and is never whole", () => {
      for (let cut = 0; cut <= sample.length; cut++) {
        const decoded = decodeUpdateLogRequest(sample.subarray(0, cut), { truncated: true });
        expect(decoded.whole).toBe(false);
        expect(decoded.rows).toEqual(full.rows.slice(0, decoded.rows.length));
      }
    });

    it("keeps every complete row before the cut", () => {
      const lastRowEnd = sample.length - 2;
      expect(decodeUpdateLogRequest(sample.subarray(0, lastRowEnd), { truncated: true })).toEqual({
        ...full,
        noMore: false,
        whole: false,
      });
      expect(
        decodeUpdateLogRequest(sample.subarray(0, lastRowEnd - 1), { truncated: true }).rows,
      ).toEqual(full.rows.slice(0, 2));
    });

    it("is a ProtoError when not marked truncated", () => {
      expectProtoError(() => decodeUpdateLogRequest(sample.subarray(0, sample.length - 1)));
    });

    it("still refuses a malformed complete row", () => {
      const body = concat(vi(0x08, 9), ld(0x1a, ld(0x12, 0xff)), bytes(0x10));
      expectProtoError(() => decodeUpdateLogRequest(body, { truncated: true }));
    });
  });
});
