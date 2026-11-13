/*
 * The job graph a workflow's `needs` make. A node is a job, not a matrix
 * instance: a dependent waits for every instance of the jobs it needs.
 *
 * Every walk here is iterative, so no workflow can exhaust the call stack,
 * and costs O(jobs + needs).
 */
import {
  type Job,
  MAX_WORKFLOW_ERRORS,
  type Position,
  type WorkflowError,
  type WorkflowErrorCode,
} from "./workflow-schema.js";

export interface GraphJob {
  readonly id: string;
  /** Position among the workflow's jobs, from 0. */
  readonly index: number;
  /** Direct needs, as written. */
  readonly needs: readonly string[];
  /** Jobs that need this one directly, in source order. */
  readonly dependents: readonly string[];
}

export interface JobGraph {
  /** Every job, each after all the jobs it needs; ties in source order. */
  readonly order: readonly GraphJob[];
  job(id: string): GraphJob | undefined;
  /**
   * Every job `id` needs, directly or through others, in source order. The
   * status functions read these, not only the direct needs: `failure()`
   * is true when any ancestor failed.
   */
  ancestors(id: string): readonly string[];
}

export type BuiltJobGraph =
  | { readonly ok: true; readonly graph: JobGraph }
  | { readonly ok: false; readonly errors: readonly WorkflowError[] };

const NEEDS = "jobs.<job_id>.needs";
/** Other jobs of a cyclic component named in its error before "and N more". */
const MAX_NAMED_JOBS = 10;
/** Code points of a user's id kept where a message quotes it. */
const MAX_QUOTED = 60;
/** Code points kept of an error's path and feature; a message keeps twice this (the parser's). */
const MAX_ERROR_FIELD = 200;

/** Orders `jobs` by their needs, or names every unknown need, cycle and case-only duplicate id. */
export function buildJobGraph(jobs: readonly Pick<Job, "id" | "needs">[]): BuiltJobGraph {
  const errors = new Errors();
  const n = jobs.length;
  const indexOf = new Map<string, number>();
  const byFolded = new Map<string, number>();
  jobs.forEach((job, i) => {
    const id = job.id.value;
    indexOf.set(id, i);
    // Job ids are ASCII (the parser checks them), so lowercasing is the whole fold.
    const folded = id.toLowerCase();
    const other = byFolded.get(folded);
    if (other === undefined) byFolded.set(folded, i);
    else {
      const first = jobs[other]?.id.value ?? "";
      errors.add(
        "duplicate_key",
        "jobs.<job_id>",
        `jobs.${id}`,
        job.id.at,
        `Job ids \`${cut(first)}\` and \`${cut(id)}\` differ only in case; expressions read \`needs.<job_id>\` ignoring case, so they would be ambiguous.`,
      );
    }
  });

  // edges[i]: indices job i needs, with the entry index each came from.
  const edges: { target: number; entry: number }[][] = jobs.map((job, i) => {
    const out: { target: number; entry: number }[] = [];
    job.needs.forEach((need, entry) => {
      const target = indexOf.get(need.value);
      if (target !== undefined) {
        out.push({ target, entry });
        return;
      }
      const near = byFolded.get(need.value.toLowerCase());
      const hint =
        near === undefined
          ? "."
          : `; did you mean \`${cut(jobs[near]?.id.value ?? "")}\`? Job ids match exactly.`;
      errors.add(
        "unknown_job",
        NEEDS,
        `jobs.${jobs[i]?.id.value}.needs[${entry}]`,
        need.at,
        `\`jobs.${cut(jobs[i]?.id.value ?? "")}.needs\` names \`${cut(need.value)}\`, which is not a job in this workflow${hint}`,
      );
    });
    return out;
  });

  for (const component of cyclicComponents(n, edges)) {
    reportCycle(jobs, edges, component, errors);
  }
  if (errors.any()) return { ok: false, errors: errors.list() };

  const ids = jobs.map((job) => job.id.value);
  const dependents: string[][] = jobs.map(() => []);
  edges.forEach((out, i) => {
    for (const { target } of out) dependents[target]?.push(ids[i] as string);
  });
  const nodes: GraphJob[] = jobs.map((job, i) => ({
    id: ids[i] as string,
    index: i,
    needs: job.needs.map((need) => need.value),
    dependents: dependents[i] as string[],
  }));
  const order = readyOrder(n, edges).map((i) => nodes[i] as GraphJob);

  return {
    ok: true,
    graph: {
      order,
      job: (id) => {
        const i = indexOf.get(id);
        return i === undefined ? undefined : nodes[i];
      },
      ancestors: (id) => {
        const start = indexOf.get(id);
        if (start === undefined) throw new Error(`There is no job \`${cut(id)}\`.`);
        const seen = new Uint8Array(n);
        const stack = [start];
        while (stack.length > 0) {
          const i = stack.pop() as number;
          for (const { target } of edges[i] ?? []) {
            if (seen[target]) continue;
            seen[target] = 1;
            stack.push(target);
          }
        }
        const found: string[] = [];
        for (let i = 0; i < n; i++) if (seen[i]) found.push(ids[i] as string);
        return found;
      },
    },
  };
}

/** Kahn's algorithm; of the jobs ready at each step, the lowest index goes first. */
function readyOrder(n: number, edges: readonly { target: number }[][]): number[] {
  const waiting = edges.map((out) => out.length);
  const dependents: number[][] = edges.map(() => []);
  edges.forEach((out, i) => {
    for (const { target } of out) dependents[target]?.push(i);
  });
  const ready = new MinHeap();
  for (let i = 0; i < n; i++) if (waiting[i] === 0) ready.push(i);
  const order: number[] = [];
  while (ready.size > 0) {
    const i = ready.pop();
    order.push(i);
    for (const d of dependents[i] ?? []) {
      waiting[d] = (waiting[d] as number) - 1;
      if (waiting[d] === 0) ready.push(d);
    }
  }
  return order;
}

/**
 * Strongly connected components that hold a cycle (more than one job, or a
 * job that needs itself), each as its job indices in ascending order, by
 * Tarjan's algorithm with an explicit stack.
 */
function cyclicComponents(n: number, edges: readonly { target: number }[][]): number[][] {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const found: number[][] = [];
  let next = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    // Each frame: a job and how many of its needs it has visited.
    const frames: [number, number][] = [[root, 0]];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as [number, number];
      const [v, at] = frame;
      const out = edges[v] ?? [];
      if (at < out.length) {
        frame[1] = at + 1;
        const w = (out[at] as { target: number }).target;
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v] as number, index[w] as number);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low[parent[0]] = Math.min(low[parent[0]] as number, low[v] as number);
      if (low[v] !== index[v]) continue;
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop() as number;
        onStack[w] = 0;
        component.push(w);
      } while (w !== v);
      const selfNeed = out.some((edge) => edge.target === v);
      if (component.length > 1 || selfNeed) found.push(component.sort((a, b) => a - b));
    }
  }
  return found;
}

/**
 * One error for a cyclic component, at its first job in source order and
 * that job's first need inside the component, with a real chain of needs
 * back to it found breadth first.
 */
function reportCycle(
  jobs: readonly Pick<Job, "id" | "needs">[],
  edges: readonly { target: number; entry: number }[][],
  component: readonly number[],
  errors: Errors,
): void {
  const inside = new Set(component);
  const first = component[0] as number;
  const start = (edges[first] ?? []).find((edge) => inside.has(edge.target)) as {
    target: number;
    entry: number;
  };
  // Breadth first from the first need back to `first`. A path back to `first`
  // never leaves the component; the `inside` test only stops the search
  // wandering through jobs outside it.
  const previous = new Map<number, number>([[start.target, -1]]);
  const queue = [start.target];
  for (let head = 0; head < queue.length && !previous.has(first); head++) {
    const v = queue[head] as number;
    for (const { target } of edges[v] ?? []) {
      if (!inside.has(target) || previous.has(target)) continue;
      previous.set(target, v);
      queue.push(target);
    }
  }
  const back: number[] = [];
  for (let v = first; v !== -1; v = previous.get(v) as number) back.push(v);
  // A self-need: `first` is the start, its own predecessor chain is just itself.
  const chain = start.target === first ? [first, first] : [first, ...back.reverse()];
  const name = (i: number) => `\`${cut(jobs[i]?.id.value ?? "")}\``;
  const onChain = new Set(chain);
  const others = component.filter((i) => !onChain.has(i));
  let message = `Jobs need each other in a cycle: ${chain.map(name).join(" -> ")}.`;
  if (others.length > 0)
    message += ` ${listed(others.map(name))} ${others.length === 1 ? "is" : "are"} in cycles with them too.`;
  const id = jobs[first]?.id.value;
  const need = jobs[first]?.needs[start.entry];
  errors.add(
    "dependency_cycle",
    NEEDS,
    `jobs.${id}.needs[${start.entry}]`,
    need?.at as Position,
    message,
  );
}

/** `a`, `a and b`, `a, b and c`, up to MAX_NAMED_JOBS then "and N more". */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_JOBS);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** `text` cut to at most `max` code points, without reading past them (as the parser cuts). */
function cut(text: string, max = MAX_QUOTED): string {
  if (text.length <= max) return text;
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count === max) return `${text.slice(0, end)}…`;
    count++;
    end += char.length;
  }
  return text;
}

/**
 * The first MAX_WORKFLOW_ERRORS errors in file order, whatever order they are
 * found in, then one saying there were more. Fields are cut as the parser
 * cuts them, since paths and messages quote user ids.
 */
class Errors {
  /** Sorted by position; equal positions in the order found. */
  readonly #errors: WorkflowError[] = [];
  #more = false;

  add(code: WorkflowErrorCode, feature: string, path: string, at: Position, message: string): void {
    const errors = this.#errors;
    const after = (e: WorkflowError) =>
      e.line < at.line || (e.line === at.line && e.column <= at.column);
    let i = errors.length;
    while (i > 0 && !after(errors[i - 1] as WorkflowError)) i--;
    if (i >= MAX_WORKFLOW_ERRORS) {
      this.#more = true;
      return;
    }
    errors.splice(i, 0, {
      code,
      feature: cut(feature, MAX_ERROR_FIELD),
      path: cut(path, MAX_ERROR_FIELD),
      line: at.line,
      column: at.column,
      message: cut(message, 2 * MAX_ERROR_FIELD),
    });
    if (errors.length > MAX_WORKFLOW_ERRORS) {
      errors.pop();
      this.#more = true;
    }
  }

  any(): boolean {
    return this.#errors.length > 0;
  }

  list(): WorkflowError[] {
    const sorted = [...this.#errors];
    if (this.#more) {
      sorted.push({
        code: "too_many_errors",
        feature: "",
        path: "",
        line: 0,
        column: 0,
        message: `The file has more than ${MAX_WORKFLOW_ERRORS} errors; the first ${MAX_WORKFLOW_ERRORS} are shown.`,
      });
    }
    return sorted;
  }
}

/** A binary min-heap of job indices. */
class MinHeap {
  readonly #items: number[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(value: number): void {
    const items = this.#items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((items[parent] as number) <= value) break;
      items[i] = items[parent] as number;
      i = parent;
    }
    items[i] = value;
  }

  pop(): number {
    const items = this.#items;
    const top = items[0] as number;
    const last = items.pop() as number;
    if (items.length === 0) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child =
        right < items.length && (items[right] as number) < (items[left] as number) ? right : left;
      if ((items[child] as number) >= last) break;
      items[i] = items[child] as number;
      i = child;
    }
    items[i] = last;
    return top;
  }
}
