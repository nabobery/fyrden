import { useEffect, useRef } from "react";
import {
  Form,
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type ShouldRevalidateFunctionArgs,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { type SessionUser, signedInUser } from "./lib/api.server.js";
import { api } from "./lib/cloudflare.server.js";
import { logServerError } from "./lib/log-error.server.js";
import { type ThemeMode, themeModeOf, themePreference } from "./lib/theme.js";
import { LiveHints } from "./lib/use-live.js";
import { pickThemeMode, useServerThemeMode, useThemeMode } from "./lib/use-theme-mode.js";

/**
 * Who is signed in and the API's version, for the header and footer. A
 * failure to read either (the API briefly unreachable) leaves them blank,
 * logged, rather than replacing the page with an error: the page itself may
 * hold work, such as conflict edits.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const logged = (error: unknown) => {
    logServerError(error, request);
    return null;
  };
  const [user, apiRpcVersion] = await Promise.all([
    signedInUser(context, request).catch(logged),
    api(context).rpcVersion().catch(logged),
  ]);
  return { user, apiRpcVersion, theme: themePreference(request) };
}

/**
 * The site's data is read again only when going to another page: a page's
 * own forms and re-reads (the same path) change neither who is signed in
 * (signing in and out load whole pages) nor the API's version.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

function SiteFooter() {
  const data = useRouteLoaderData("root") as { apiRpcVersion: number | null } | undefined;
  return (
    <footer className="muted" style={{ padding: "1rem", textAlign: "center" }}>
      Fyrden · API RPC version {data?.apiRpcVersion ?? "?"}
    </footer>
  );
}

/** Asks the server to keep `mode`. A redirect means kept: following it would read a page nobody shows. */
async function keepThemeMode(action: string, mode: ThemeMode): Promise<void> {
  const body = new URLSearchParams({ mode, return: "/" });
  const res = await fetch(action, { method: "POST", body, redirect: "manual" });
  if (res.type !== "opaqueredirect" && !res.ok) throw new Error(`Status ${res.status}`);
}

/**
 * System, Light or Dark. With a script the page changes in place, so nothing being written
 * is lost, and goes back if the choice cannot be kept. Without one, the form posts natively
 * and the whole page draws again in the choice.
 */
function ThemeControl() {
  const mode = useThemeMode();
  const fromServer = useServerThemeMode();
  const { pathname, search } = useLocation();
  const shown = useRef(mode);
  useEffect(() => {
    if (shown.current === mode) return;
    shown.current = mode;
    // Diagrams are images: the page's colours cannot reach them.
    if (document.querySelector("figure.mermaid")) {
      void import("./lib/mermaid.client.js").then(({ redrawDiagrams }) => redrawDiagrams());
    }
  }, [mode]);
  const pick = (event: React.FormEvent<HTMLFormElement>) => {
    const { submitter } = event.nativeEvent as SubmitEvent;
    if (!submitter) return;
    event.preventDefault();
    const choice = themeModeOf(submitter.getAttribute("value"));
    if (!choice) return;
    const action = event.currentTarget.action;
    void pickThemeMode(choice, fromServer, (mode) => keepThemeMode(action, mode));
  };
  return (
    <form
      method="post"
      action="/appearance"
      className="theme-control"
      aria-label="Colour scheme"
      onSubmit={pick}
    >
      <input type="hidden" name="return" value={`${pathname}${search}`} />
      {(["system", "light", "dark"] as const).map((choice) => (
        <button
          key={choice}
          type="submit"
          name="mode"
          value={choice}
          aria-pressed={mode === choice}
        >
          {choice[0]?.toUpperCase()}
          {choice.slice(1)}
        </button>
      ))}
    </form>
  );
}

function SiteHeader() {
  const data = useRouteLoaderData("root") as { user: SessionUser | null } | undefined;
  const user = data?.user ?? null;
  return (
    <header className="site">
      <Link className="brand" to="/">
        Fyrden
      </Link>
      <nav aria-label="Site">
        {user && (
          <>
            <Link to="/">Repositories</Link>
            <Link to="/notifications">Inbox</Link>
            <Link to="/settings/tokens">Tokens</Link>
            <Link to="/settings/agents">Agents</Link>
            <Link to="/settings/notifications">Notifications</Link>
          </>
        )}
      </nav>
      {user && (
        <Form method="get" action="/search" role="search" className="site-search">
          <label htmlFor="site-search" className="visually-hidden">
            Search issues, pull requests and repositories
          </label>
          <input id="site-search" name="q" type="search" placeholder="Search (repo:owner/name …)" />
        </Form>
      )}
      <ThemeControl />
      {user ? (
        <form method="post" action="/sign-out" className="row">
          <span className="muted">{user.handle}</span>
          <button type="submit">Sign out</button>
        </form>
      ) : (
        <a href="/auth/sign-in?return_to=%2F">Sign in</a>
      )}
    </header>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Marks the page once React has taken it over (its forms send through the app from then on):
  // what a test waits for before it acts as a person with the page's scripts would.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "";
  }, []);
  // The last viewer known: a session check that failed reads as no one, and signing in or out
  // loads a whole page, so the tab's live hints outlast a failed check (and an error page).
  const data = useRouteLoaderData("root") as { user: SessionUser | null } | undefined;
  const viewer = useRef<string | null>(null);
  if (data?.user) viewer.current = data.user.id;
  const mode = useThemeMode();
  return (
    <html lang="en" data-theme={mode === "system" ? undefined : mode}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <SiteHeader />
        <LiveHints viewer={viewer.current}>{children}</LiveHints>
        <SiteFooter />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const detail =
    isRouteErrorResponse(error) && typeof error.data === "string"
      ? error.data
      : "Something went wrong.";
  return (
    <main>
      <h1>{status === 404 ? "Not found" : `Error ${status}`}</h1>
      <p>{detail}</p>
    </main>
  );
}
