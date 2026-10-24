import { countD1Statements } from "./invocation.js";

/*
 * A D1 binding that counts every statement it runs against the current
 * invocation's tally (`SubrequestTally.d1`), whoever runs it: a helper
 * with no metric of its own counts too, so work bounded by D1's queries an
 * invocation can be admitted against what the invocation has run.
 */

/** `db` (and the sessions it opens), each statement counted as it runs, each of a batch too. */
export function countedD1<T extends D1Database | D1DatabaseSession>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => countedStatement(target.prepare(query));
      if (prop === "batch")
        return (statements: D1PreparedStatement[]) => {
          countD1Statements(statements.length);
          return target.batch(statements);
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
  return new Proxy(statement, {
    get(target, prop) {
      if (prop === "bind")
        return (...values: unknown[]) => countedStatement(target.bind(...values));
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "run" || prop === "all" || prop === "first" || prop === "raw")
        return (...args: unknown[]) => {
          countD1Statements();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      return value.bind(target);
    },
  });
}
