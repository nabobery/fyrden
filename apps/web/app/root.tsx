import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { type SessionUser, signedInUser } from "./lib/api.server.js";
import { api } from "./lib/cloudflare.server.js";

export async function loader({ request, context }: Route.LoaderArgs) {
  const [user, apiRpcVersion] = await Promise.all([
    signedInUser(context, request),
    api(context).rpcVersion(),
  ]);
  return { user, apiRpcVersion };
}

function SiteFooter() {
  const data = useRouteLoaderData("root") as { apiRpcVersion: number } | undefined;
  return (
    <footer className="muted" style={{ padding: "1rem", textAlign: "center" }}>
      Fyrden · API RPC version {data?.apiRpcVersion ?? "?"}
    </footer>
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
            <Link to="/settings/tokens">Tokens</Link>
            <Link to="/settings/agents">Agents</Link>
          </>
        )}
      </nav>
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
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <SiteHeader />
        {children}
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
