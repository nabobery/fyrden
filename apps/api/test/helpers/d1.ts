// A D1 binding that counts what it runs, for tests bounding the queries an
// invocation makes.

/** `db` (and its sessions), counting every statement it runs, each of a batch too. */
export function countingD1(
  db: D1Database | D1DatabaseSession,
  count: { queries: number },
): D1Database {
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw")
          return (...args: unknown[]) => {
            count.queries++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return value.bind(target);
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => statement(target.prepare(query));
      if (prop === "batch")
        return (statements: D1PreparedStatement[]) => {
          count.queries += statements.length;
          return target.batch(statements);
        };
      if (prop === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          countingD1((target as D1Database).withSession(constraint), count);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}
