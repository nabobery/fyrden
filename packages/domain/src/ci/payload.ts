/*
 * One job instance as the runner's `workflow_payload`: a one-job workflow
 * written as JSON text, which is a YAML 1.2 document the runner's reader
 * takes as it is. Every string is double-quoted, so nothing the Go YAML
 * library might retype (`yes`, `on`, `0x10`) loses its type, and user keys
 * stay data.
 *
 * The runner evaluates a job's name, labels and matrix again. Every string
 * Fyrden evaluated (the instance's name, labels, matrix keys and values) is
 * written through `quoteForRunner`, so that second evaluation gives back
 * exactly what Fyrden evaluated, never a secret or an inserted mapping. The
 * job's `if:` is `${{ always() }}`: Fyrden has already decided the job runs.
 * Fields Fyrden does not evaluate (env, steps, outputs, services, container)
 * are written as written, for the runner to evaluate once.
 *
 * One emitter writes to a sink: a counting sink adds up the exact UTF-8
 * size without building anything, a writing sink builds the bytes. The
 * instance's own fields are one group at the start of the job, so a
 * payload's size is the job's invariant part plus that group, and both are
 * known before a payload is built.
 */
import { quoteForRunner } from "./expressions.js";
import type { MatrixValue } from "./matrix.js";
import type {
  Container,
  Job,
  Pairs,
  RunDefaults,
  Step,
  Text,
  Trigger,
  Valued,
  Workflow,
} from "./workflow-schema.js";

/** One instance of a job, with every field Fyrden evaluated for it. */
export interface PayloadInstance {
  readonly name: string;
  readonly runsOn: readonly string[];
  /** Present when the job declares a strategy. */
  readonly strategy?: {
    readonly failFast: boolean;
    readonly maxParallel?: number;
    /** Present for a matrix job: its combination, from 0 of `total`. */
    readonly matrix?: {
      readonly combination: ReadonlyMap<string, MatrixValue>;
      readonly index: number;
      readonly total: number;
    };
  };
  readonly timeoutMinutes?: number;
  readonly continueOnError?: boolean;
}

/** Four times the largest workflow file: aliases can make a payload far larger than its file. Proposed. */
export const MAX_PAYLOAD_BYTES = 2_000_000;

/** The job instance's payload, as UTF-8. Callers check the size first; over the cap is a bug. */
export function jobPayload(
  workflow: Workflow,
  jobId: string,
  instance: PayloadInstance,
): Uint8Array {
  const job = jobOf(workflow, jobId);
  const sink = new WritingSink();
  emitPayload(sink, workflow, job, instance);
  return sink.bytes();
}

/** The payload's size without the instance's group: the same for every instance of the job. */
export function invariantPayloadBytes(workflow: Workflow, jobId: string): number {
  const job = jobOf(workflow, jobId);
  const sink = new CountingSink();
  emitPayload(sink, workflow, job, undefined);
  return sink.size;
}

/** The size of an instance's own group of fields. */
export function instancePayloadBytes(instance: PayloadInstance): number {
  const sink = new CountingSink();
  emitInstance(sink, instance);
  return sink.size;
}

function jobOf(workflow: Workflow, jobId: string): Job {
  const job = workflow.jobs.find((j) => j.id.value === jobId);
  if (!job) throw new Error(`The workflow has no job \`${jobId}\`.`);
  return job;
}

// Sinks ---------------------------------------------------------------------------------

interface Sink {
  /** Structural JSON text: ASCII only. */
  raw(text: string): void;
  /** A JSON string literal for `value`. */
  string(value: string): void;
}

class CountingSink implements Sink {
  size = 0;

  raw(text: string): void {
    this.size += text.length;
  }

  string(value: string): void {
    this.size += quotedSize(value);
  }
}

class WritingSink implements Sink {
  readonly #parts: string[] = [];
  #size = 0;

  raw(text: string): void {
    this.#add(text, text.length);
  }

  string(value: string): void {
    this.#add(quoted(value), quotedSize(value));
  }

  #add(text: string, size: number): void {
    this.#size += size;
    if (this.#size > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `The payload is over ${MAX_PAYLOAD_BYTES} bytes; its size is checked before it is built.`,
      );
    }
    this.#parts.push(text);
  }

  bytes(): Uint8Array {
    return new TextEncoder().encode(this.#parts.join(""));
  }
}

/** The short escapes JSON has; other controls are written `\u00XX`. */
const SHORT: Readonly<Record<number, string>> = {
  8: "\\b",
  9: "\\t",
  10: "\\n",
  12: "\\f",
  13: "\\r",
  34: '\\"',
  92: "\\\\",
};

const isSeparator = (unit: number) => unit === 0x2028 || unit === 0x2029;

/**
 * Whether the unit at `i` is written as `\uXXXX`. Controls without a short
 * escape, as JSON requires. The runner's YAML reader treats U+2028 and
 * U+2029 as line breaks, even escaped, and drops a raw space right after
 * one, so both are escaped and so is that space (measured on the pinned
 * reader: `"a\u2028\u0020b"` reads back exactly, `"a\u2028 b"` loses the
 * space). NEL (U+0085) cannot be delivered at all: the reader drops it in
 * every form (`\u0085`, `\N`, raw), so it is refused before a payload is
 * built and refused here as a bug. U+FFFE and U+FFFF are refused raw by the
 * reader ("control characters are not allowed") and read back escaped.
 */
function isLongEscape(value: string, i: number): boolean {
  const unit = value.charCodeAt(i);
  if (unit === 0x85) throw notDeliverable();
  return (
    (unit < 0x20 && SHORT[unit] === undefined) ||
    isSeparator(unit) ||
    unit === 0xfffe ||
    unit === 0xffff ||
    (unit === 0x20 && i > 0 && isSeparator(value.charCodeAt(i - 1)))
  );
}

/** `value` as a JSON string literal. */
function quoted(value: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    const short = SHORT[unit];
    if (short === undefined && !isLongEscape(value, i)) continue;
    out += value.slice(start, i) + (short ?? `\\u${unit.toString(16).padStart(4, "0")}`);
    start = i + 1;
  }
  return `${out}${value.slice(start)}"`;
}

/** The UTF-8 size of `quoted(value)`, without building it; refuses a lone surrogate. */
function quotedSize(value: string): number {
  let size = 2;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (SHORT[unit] !== undefined) size += 2;
    else if (isLongEscape(value, i)) size += 6;
    else if (unit < 0x80) size += 1;
    else if (unit < 0x800) size += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw notWellFormed();
      size += 4;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw notWellFormed();
    else size += 3;
  }
  return size;
}

const notDeliverable = () =>
  new Error(
    "A string in the payload holds NEL (U+0085), which the runner cannot read; strings are checked before a payload is built.",
  );

const notWellFormed = () =>
  new Error(
    "A string in the payload is not well-formed UTF-16; strings are checked before a payload is built.",
  );

// The emitter ---------------------------------------------------------------------------

/** Writes `{"k":v,...}`, calling `each` for every value after its key. */
function object<T>(
  sink: Sink,
  entries: Iterable<readonly [string, T]>,
  each: (value: T) => void,
): void {
  sink.raw("{");
  let first = true;
  for (const [key, value] of entries) {
    if (!first) sink.raw(",");
    first = false;
    sink.string(key);
    sink.raw(":");
    each(value);
  }
  sink.raw("}");
}

function list<T>(sink: Sink, items: Iterable<T>, each: (item: T) => void): void {
  sink.raw("[");
  let first = true;
  for (const item of items) {
    if (!first) sink.raw(",");
    first = false;
    each(item);
  }
  sink.raw("]");
}

function number(sink: Sink, value: number): void {
  if (!Number.isFinite(value)) throw new Error("A number in the payload is not finite.");
  sink.raw(JSON.stringify(value));
}

function scalar(sink: Sink, value: string | number | boolean | null): void {
  if (typeof value === "string") sink.string(value);
  else if (typeof value === "number") number(sink, value);
  else sink.raw(value === null ? "null" : value ? "true" : "false");
}

/** An evaluated matrix value: every string, key or value, through `quoteForRunner`. */
function matrixValue(sink: Sink, value: MatrixValue): void {
  if (value === null || typeof value !== "object") {
    scalar(sink, typeof value === "string" ? quoteForRunner(value) : value);
  } else if (value.kind === "array") {
    list(sink, value.items, (item) => matrixValue(sink, item));
  } else {
    object(sink, protectKeys(value.entries), (item) => matrixValue(sink, item));
  }
}

function* protectKeys(entries: ReadonlyMap<string, MatrixValue>): Iterable<[string, MatrixValue]> {
  for (const [key, value] of entries) yield [quoteForRunner(key), value];
}

const pairs = (sink: Sink, values: Pairs) =>
  object(
    sink,
    values.map(([k, v]) => [k.value, v.value] as const),
    (v) => sink.string(v),
  );

/** A field as written: a literal as its value, an expression as its source. */
function valued(sink: Sink, field: Valued<number | boolean>): void {
  if (field.kind === "expression") sink.string(field.source);
  else scalar(sink, field.value);
}

/** Keys with a value, in order, written with `object`; `undefined` values are skipped. */
type Field = readonly [string, (() => void) | undefined];
function fields(sink: Sink, entries: readonly Field[]): void {
  object(
    sink,
    entries.filter((e): e is readonly [string, () => void] => e[1] !== undefined),
    (write) => write(),
  );
}

const text = (sink: Sink, t: Text | undefined) => (t ? () => sink.string(t.value) : undefined);
const texts = (sink: Sink, ts: readonly Text[]) =>
  ts.length > 0 ? () => list(sink, ts, (t) => sink.string(t.value)) : undefined;
const nonEmpty = (sink: Sink, values: Pairs) =>
  values.length > 0 ? () => pairs(sink, values) : undefined;

function defaults(sink: Sink, value: RunDefaults | undefined): (() => void) | undefined {
  if (!value) return undefined;
  return () =>
    fields(sink, [
      [
        "run",
        () =>
          fields(sink, [
            ["shell", text(sink, value.shell)],
            ["working-directory", text(sink, value.workingDirectory)],
          ]),
      ],
    ]);
}

function container(sink: Sink, value: Container): void {
  fields(sink, [
    ["image", () => sink.string(value.image.value)],
    [
      "credentials",
      value.credentials
        ? () =>
            fields(sink, [
              ["username", text(sink, value.credentials?.username)],
              ["password", text(sink, value.credentials?.password)],
            ])
        : undefined,
    ],
    ["env", nonEmpty(sink, value.env)],
    ["ports", texts(sink, value.ports)],
    ["volumes", texts(sink, value.volumes)],
    ["options", text(sink, value.options)],
  ]);
}

function step(sink: Sink, value: Step): void {
  fields(sink, [
    ["id", text(sink, value.id)],
    ["name", text(sink, value.name)],
    ["if", value.if ? () => sink.string(value.if?.source ?? "") : undefined],
    ...(value.kind === "run"
      ? ([
          ["run", () => sink.string(value.run.value)],
          ["shell", text(sink, value.shell)],
          ["working-directory", text(sink, value.workingDirectory)],
        ] as const)
      : ([
          ["uses", () => sink.string(value.uses.value)],
          ["with", nonEmpty(sink, value.with)],
        ] as const)),
    ["env", nonEmpty(sink, value.env)],
    [
      "continue-on-error",
      value.continueOnError
        ? () => valued(sink, value.continueOnError as Valued<boolean>)
        : undefined,
    ],
    [
      "timeout-minutes",
      value.timeoutMinutes ? () => valued(sink, value.timeoutMinutes as Valued<number>) : undefined,
    ],
  ]);
}

/**
 * Event names, and `workflow_dispatch` with its inputs: the runner reads
 * only the names and the inputs' types and defaults. Filters are Fyrden's.
 */
function on(sink: Sink, triggers: readonly Trigger[]): void {
  object(
    sink,
    triggers.map((t) => [t.event, t] as const),
    (trigger) => {
      if (trigger.event !== "workflow_dispatch") {
        sink.raw("null");
        return;
      }
      fields(sink, [
        [
          "inputs",
          () =>
            object(
              sink,
              trigger.inputs.map((input) => [input.id.value, input] as const),
              (input) =>
                fields(sink, [
                  ["description", text(sink, input.description)],
                  ["required", () => scalar(sink, input.required)],
                  [
                    "default",
                    input.default ? () => scalar(sink, input.default?.value ?? null) : undefined,
                  ],
                  ["type", () => sink.string(input.type)],
                  ["options", texts(sink, input.options)],
                ]),
            ),
        ],
      ]);
    },
  );
}

const EMPTY = `\${{ '' }}`;

/** The instance's own fields, each followed by a comma: the group at the start of the job. */
function emitInstance(sink: Sink, instance: PayloadInstance): void {
  const field = (key: string, write: () => void) => {
    sink.string(key);
    sink.raw(":");
    write();
    sink.raw(",");
  };
  // The reader replaces an empty name with the job id; an expression giving '' keeps it empty.
  field("name", () => sink.string(instance.name === "" ? EMPTY : quoteForRunner(instance.name)));
  field("runs-on", () =>
    list(sink, instance.runsOn, (label) => sink.string(quoteForRunner(label))),
  );
  const { strategy } = instance;
  if (strategy) {
    field("strategy", () =>
      fields(sink, [
        ["fail-fast", () => scalar(sink, strategy.failFast)],
        [
          "max-parallel",
          strategy.maxParallel === undefined
            ? undefined
            : () => number(sink, strategy.maxParallel as number),
        ],
        [
          "matrix",
          strategy.matrix
            ? () =>
                fields(sink, [
                  [
                    "include",
                    () =>
                      list(
                        sink,
                        [strategy.matrix?.combination as ReadonlyMap<string, MatrixValue>],
                        (c) => object(sink, protectKeys(c), (v) => matrixValue(sink, v)),
                      ),
                  ],
                ])
            : undefined,
        ],
        [
          "job-index",
          strategy.matrix ? () => number(sink, strategy.matrix?.index as number) : undefined,
        ],
        [
          "job-total",
          strategy.matrix ? () => number(sink, strategy.matrix?.total as number) : undefined,
        ],
      ]),
    );
  }
  if (instance.timeoutMinutes !== undefined) {
    field("timeout-minutes", () => number(sink, instance.timeoutMinutes as number));
  }
  if (instance.continueOnError !== undefined) {
    field("continue-on-error", () => scalar(sink, instance.continueOnError as boolean));
  }
}

/** The whole payload; with no instance, everything but the instance's group (for its size). */
function emitPayload(
  sink: Sink,
  workflow: Workflow,
  job: Job,
  instance: PayloadInstance | undefined,
): void {
  fields(sink, [
    ["name", text(sink, workflow.name)],
    ["on", () => on(sink, workflow.on)],
    ["env", nonEmpty(sink, workflow.env)],
    ["defaults", defaults(sink, workflow.defaults)],
    [
      "jobs",
      () =>
        object(sink, [[job.id.value, job] as const], (j) => {
          sink.raw("{");
          if (instance) emitInstance(sink, instance);
          if (j.needs.length > 0) {
            sink.string("needs");
            sink.raw(":");
            list(sink, j.needs, (need) => sink.string(need.value));
            sink.raw(",");
          }
          sink.string("if");
          sink.raw(`:"\${{ always() }}"`);
          const rest: Field[] = [
            ["env", nonEmpty(sink, j.env)],
            ["defaults", defaults(sink, j.defaults)],
            ["outputs", nonEmpty(sink, j.outputs)],
            [
              "services",
              j.services.length > 0
                ? () =>
                    object(
                      sink,
                      j.services.map((s) => [s.id.value, s] as const),
                      (s) => container(sink, s),
                    )
                : undefined,
            ],
            [
              "container",
              j.container ? () => container(sink, j.container as Container) : undefined,
            ],
            ["steps", () => list(sink, j.steps, (s) => step(sink, s))],
          ];
          for (const [key, write] of rest) {
            if (!write) continue;
            sink.raw(",");
            sink.string(key);
            sink.raw(":");
            write();
          }
          sink.raw("}");
        }),
    ],
  ]);
}
