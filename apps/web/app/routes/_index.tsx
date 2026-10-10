import { api } from "../lib/cloudflare.server.js";
import type { Route } from "./+types/_index";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Fyrden" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  return { apiRpcVersion: await api(context).rpcVersion() };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Fyrden</h1>
      <p>API RPC version {loaderData.apiRpcVersion}</p>
    </main>
  );
}
