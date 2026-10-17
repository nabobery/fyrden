// A route's page rendered to HTML as the server would, with the loader data
// (and action data) given, so a test reads what a person is shown.

import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

export function renderPage(
  // biome-ignore lint/suspicious/noExplicitAny: each route's own props
  Component: ComponentType<any>,
  path: string,
  loaderData: unknown,
  actionData?: unknown,
): string {
  const Stub = createRoutesStub([{ id: "page", path: path.split("?")[0] ?? path, Component }]);
  return renderToString(
    <Stub
      initialEntries={[path]}
      hydrationData={{
        loaderData: { page: loaderData },
        ...(actionData !== undefined && { actionData: { page: actionData } }),
      }}
    />,
  );
}

/** A tag a hostile string must never become: one that runs script or loads anything. */
export const ACTIVE_TAG = /<(script|img|svg|iframe|object|embed|style|link|meta|base)\b/i;

/** A string that is markup, a script and an attribute break-out wherever it lands unescaped. */
export const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)">"' onmouseover="alert(3)`;

/** `text` as React writes it into HTML (text or an attribute value). */
export const escaped = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
