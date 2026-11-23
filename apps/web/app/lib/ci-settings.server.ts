/*
 * Actions secrets and variables as the settings pages manage them, through
 * the API's own operations (the ones `gh secret` and `gh variable` call): a
 * secret's value is sealed here, in the web Worker, for the scope's public key
 * and never leaves this module in plain text (not in a result, an error, a log
 * line, a redirect or a header).
 */
import { ciValueBytes, MAX_CI_VALUE_BYTES } from "@fyrden/domain";
import { type RouterContextProvider, redirect } from "react-router";
import type { SettingsScope } from "../components/settings-shell.js";
import {
  type ApiResult,
  apiCall,
  apiCallBounded,
  apiGet,
  bodyOf,
  type Problem,
  readForm,
  signInUrl,
} from "./api.server.js";
import type { CiScope } from "./ci-settings.js";
import type { PageLinks } from "./pages.js";
import { sealBox } from "./sealed-box.server.js";
import { pageUrl } from "./target.js";
import type { Repo } from "./types.js";

/**
 * The largest form the value pages read: a legal value is at most 49,152
 * bytes, and multipart sends each line break as CRLF (2 bytes for 1), plus
 * room for the boundaries and the other fields.
 */
export const CI_VALUE_FORM_MAX_BYTES = 2 * MAX_CI_VALUE_BYTES + 16 * 1024;

/** The scope's operations under the API. */
export function apiBase(scope: CiScope): string {
  return scope.kind === "repository"
    ? `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`
    : `/orgs/${encodeURIComponent(scope.org)}`;
}

/** A value page's form, or `too-large` when its body is over the cap (a value over 48 KiB). */
export async function readValueForm(request: Request): Promise<FormData | "too-large"> {
  try {
    return await readForm(request, CI_VALUE_FORM_MAX_BYTES);
  } catch (error) {
    if (statusOf(error) === 413) return "too-large";
    throw error;
  }
}

function statusOf(thrown: unknown): number | undefined {
  if (typeof thrown !== "object" || thrown === null || !("init" in thrown)) return undefined;
  const init = (thrown as { init?: ResponseInit | null }).init;
  return init?.status;
}

/** A browser sends a textarea's line breaks as CRLF; values are stored with `\n`. */
export const normalizeLineBreaks = (value: string): string => value.replaceAll("\r\n", "\n");

/** Whether `value` (already normalized) fits a secret or variable. */
export const fitsValue = (value: string): boolean => ciValueBytes(value) <= MAX_CI_VALUE_BYTES;

const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** What a write answered: its status, and the problem when it failed. */
export interface WriteResult {
  readonly status: number;
  readonly problem: Problem | null;
}

const resultOf = (result: ApiResult<Problem | null>): WriteResult => ({
  status: result.status,
  problem: result.status >= 400 ? (result.body ?? { status: result.status }) : null,
});

/**
 * Seals `value` for the scope's current public key and sets the secret
 * `name` (`PUT …/actions/secrets/{name}`). The key is read here, on every
 * write: never from a loader (reading it may create the scope's key, and it
 * answers 503 without a CI key) and never from the form. When the key changed
 * between reading and writing (`bad_key_id`), it is read and sealed once more.
 */
export async function putSealedSecret(
  context: Readonly<RouterContextProvider>,
  request: Request,
  scope: CiScope,
  name: string,
  value: string,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<WriteResult> {
  const message = new TextEncoder().encode(value);
  try {
    let last: WriteResult = { status: 0, problem: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = await apiCall<{ key_id: string; key: string } & Problem>(
        context,
        request,
        "GET",
        `${apiBase(scope)}/actions/secrets/public-key`,
      );
      if (key.status !== 200) return resultOf(key as ApiResult<Problem>);
      const sealed = await sealBox(fromBase64(key.body.key), message);
      last = resultOf(
        await apiCall<Problem | null>(
          context,
          request,
          "PUT",
          `${apiBase(scope)}/actions/secrets/${encodeURIComponent(name)}`,
          { ...fields, encrypted_value: base64(sealed), key_id: key.body.key_id },
        ),
      );
      if (last.problem?.code !== "bad_key_id") return last;
    }
    return last;
  } finally {
    message.fill(0);
  }
}

/** Any other write of these pages (variables, deletes, repository access). */
export async function write(
  context: Readonly<RouterContextProvider>,
  request: Request,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<WriteResult> {
  return resultOf(await apiCall<Problem | null>(context, request, method, path, body));
}

/** A failed write's problem; signed out, a redirect to sign in instead. */
export function problemOf(result: WriteResult, request: Request): Problem | null {
  if (result.status === 401) throw redirect(signInUrl(request));
  return result.problem;
}

/** The page's header: the repository (which the viewer must see), or the organization's name. */
export async function loadShell(
  context: Readonly<RouterContextProvider>,
  request: Request,
  scope: CiScope,
): Promise<SettingsScope> {
  if (scope.kind === "organization") return { kind: "organization", org: scope.org };
  const repo = await apiGet<Repo>(context, request, apiBase(scope));
  return { kind: "repository", repo, origin: new URL(request.url).origin };
}

/** The page number `param` names in the page's URL (1 when absent or not a page). */
export function pageNumber(request: Request, param: string): number {
  const value = new URL(request.url).searchParams.get(param);
  const n = value !== null && /^[1-9][0-9]{0,3}$/.test(value) ? Number(value) : 1;
  return Math.min(n, 1_000);
}

/** Links to the next page and the first of a list paged by number under `param`. */
export function numberedPages(
  request: Request,
  param: string,
  page: number,
  perPage: number,
  total: number,
): PageLinks {
  const url = pageUrl(new URL(request.url));
  const at = (n: number | null) => {
    const query = new URLSearchParams(url.search);
    for (const notice of ["created", "saved", "deleted"]) query.delete(notice);
    if (n === null) query.delete(param);
    else query.set(param, String(n));
    const search = query.toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  };
  return {
    next: page * perPage < total && page < 1_000 ? at(page + 1) : null,
    first: page > 1 ? at(null) : null,
  };
}

/** A list the viewer must be allowed to read, read within the page's byte bound. */
export async function readList<T>(
  context: Readonly<RouterContextProvider>,
  request: Request,
  path: string,
  perPage: number,
  page: number,
): Promise<T> {
  return bodyOf(
    await apiCallBounded<T>(context, request, `${path}?per_page=${perPage}&page=${page}`),
    request,
  );
}

/** The most of a variable's value a list shows. */
export const LIST_VALUE_CHARS = 200;

/** `value` cut to what a list shows (never between the halves of a surrogate pair). */
export function shortValue(value: string): string {
  if (value.length <= LIST_VALUE_CHARS) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(LIST_VALUE_CHARS - 1))
    ? LIST_VALUE_CHARS - 1
    : LIST_VALUE_CHARS;
  return `${value.slice(0, end)}…`;
}
