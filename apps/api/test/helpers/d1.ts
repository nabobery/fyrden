// A D1 binding that counts what it runs, for tests bounding the queries an
// invocation makes.

/**
 * `db` (and its sessions), counting every statement it runs, each of a
 * batch too, and (when `count` has the field) every call it makes: a
 * statement run alone, or a batch.
 */
export function countingD1(
  db: D1Database | D1DatabaseSession,
  count: { queries: number; calls?: number },
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
            if (count.calls !== undefined) count.calls++;
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
          if (count.calls !== undefined) count.calls++;
          return target.batch(statements);
        };
      if (prop === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          countingD1((target as D1Database).withSession(constraint), count);
      // One statement and one call, as an invocation's tally counts it.
      if (prop === "exec")
        return (query: string) => {
          count.queries++;
          if (count.calls !== undefined) count.calls++;
          return (target as D1Database).exec(query);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/**
 * `db` (and its sessions), adding the rows D1 reports for everything it runs
 * to `rows`: what the platform bills, whether or not an invocation's tally
 * is counting.
 */
export function rowCountingD1(
  db: D1Database | D1DatabaseSession,
  rows: { read: number; written: number; statements?: string[] },
): D1Database {
  const note = <T extends D1Result<unknown> | D1ExecResult>(result: T): T => {
    const meta = (result as D1Result<unknown>).meta;
    rows.read += meta?.rows_read ?? 0;
    rows.written += meta?.rows_written ?? 0;
    return result;
  };
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        if (prop === "run" || prop === "all") return async () => note(await target.all());
        // `raw` answers without its meta: it fails the test rather than go uncounted.
        if (prop === "raw") throw new Error("rowCountingD1 cannot count raw()");
        // `first` answers without its meta: read as `all`, answered as it would.
        if (prop === "first")
          return async (column?: string) => {
            const row = note(await target.all<Record<string, unknown>>()).results[0] ?? null;
            return column === undefined || row === null ? row : (row[column] ?? null);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (query: string) => {
          rows.statements?.push(query);
          return statement(target.prepare(query));
        };
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const result of results) note(result);
          return results;
        };
      if (prop === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          rowCountingD1((target as D1Database).withSession(constraint), rows);
      if (prop === "exec") throw new Error("rowCountingD1 cannot count exec()");
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}
