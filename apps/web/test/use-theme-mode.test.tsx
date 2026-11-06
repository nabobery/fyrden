// The theme control and the renderers read the visitor's scheme from the root's data,
// which an error page may not have: they fall back to System rather than fail too.

import { renderToString } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { useThemeMode } from "../app/lib/use-theme-mode.js";

function Mode() {
  return <p>{useThemeMode()}</p>;
}

function page(hydrationData: Parameters<typeof createMemoryRouter>[1]) {
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        element: <Outlet />,
        errorElement: <Mode />,
        children: [{ index: true, element: <Mode /> }],
      },
    ],
    hydrationData,
  );
  const html = renderToString(<RouterProvider router={router} />);
  router.dispose();
  return html;
}

describe("the visitor's colour scheme", () => {
  it("comes from the root's data", () => {
    expect(page({ hydrationData: { loaderData: { root: { theme: "dark" } } } })).toContain(
      ">dark<",
    );
  });

  it("is System when the root's loader threw", () => {
    expect(
      page({ hydrationData: { loaderData: {}, errors: { root: new Error("refused") } } }),
    ).toContain(">system<");
  });
});
