import { countD1Rows, countD1Statements } from "./invocation.js";

/*
 * A D1 binding that counts every statement it runs against the current
 * invocation's tally (`SubrequestTally.d1`), whoever runs it: a helper
 * with no metric of its own counts too, so work bounded by D1's queries an
 * invocation can be admitted against what the invocation has run.
 */

/** Marks a binding (or session) already counted: wrapping it again counts nothing twice. */
const COUNTED = Symbol("countedD1");

/**
 * `db` (and the sessions it opens), each execution counted as it runs (its
 * statements, and in an invocation counting by its bindings, its internal
 * call: a batch is one), counted before it is sent, so one that throws
 * counts too. Wrapping a counted binding again returns it as it is.
 */
export function countedD1<T extends D1Database | D1DatabaseSession>(db: T): T {
  if ((db as unknown as Record<symbol, unknown>)[COUNTED]) return db;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === COUNTED) return true;
      if (prop === "prepare") return (query: string) => countedStatement(target.prepare(query));
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          countD1Statements(statements.length);
          const results = await target.batch(statements);
          for (const result of results) countD1Rows(result?.meta);
          return results;
        };
      if (prop === "exec")
        return (query: string) => {
          countD1Statements();
          return (target as D1Database).exec(query);
        };
      if (prop === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          countedD1((target as D1Database).withSession(constraint));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countedStatement(statement: D1PreparedStatement): D1PreparedStatement {
  if ((statement as unknown as Record<symbol, unknown>)[COUNTED]) return statement;
  return new Proxy(statement, {
    get(target, prop) {
      if (prop === COUNTED) return true;
      if (prop === "bind")
        return (...values: unknown[]) => countedStatement(target.bind(...values));
      // As D1 answers it (its first row, or that row's column), read through `all` so its rows
      // are counted too.
      if (prop === "first")
        return async (column?: string) => {
          countD1Statements();
          const result = await target.all<Record<string, unknown>>();
          countD1Rows(result?.meta);
          const row = result?.results?.[0];
          if (row === undefined) return null;
          return column === undefined ? row : (row[column] ?? null);
        };
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "run" || prop === "all")
        return async (...args: unknown[]) => {
          countD1Statements();
          const result = (await (value as (...a: unknown[]) => Promise<D1Result>).apply(
            target,
            args,
          )) as D1Result;
          countD1Rows(result?.meta);
          return result;
        };
      if (prop === "raw")
        return (...args: unknown[]) => {
          countD1Statements();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      return value.bind(target);
    },
  });
}
