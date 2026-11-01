/**
 * What a page's edit forms send and are answered with, shared by the
 * server's actions and the page's editors: an answer is about one scope
 * (who, and what page), and a refused edit comes back as a draft.
 */

/** Whose and what an action's answer is about: a page shows it only in the same scope. */
export type Scope = Readonly<{ viewer: string } & Record<string, string | number>>;

/** What a refused edit wrote, the version it was written from, and the item it was for. */
export interface Draft {
  readonly fields: Readonly<Record<string, string>>;
  readonly version?: number | undefined;
  readonly target?: number | undefined;
}

/** What a form wrote, before the version it was written from is added. */
export type Written = { fields: Record<string, string>; target?: number };

/** An edit action's answer: done (and the version it made), or refused (and the draft). */
export type EditResult<S extends Scope> =
  | {
      ok: string;
      /** The item the change was of, if any. */
      target?: number | undefined;
      /** The version the change made (its record's, as the API answered). */
      version?: number | undefined;
      scope: S;
      error?: undefined;
      draft?: undefined;
    }
  | { error: string; scope?: S; draft?: Draft | undefined; ok?: undefined };

/** Whether two scopes name the same viewer and page. */
export function sameScope(a: Scope, b: Scope): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
