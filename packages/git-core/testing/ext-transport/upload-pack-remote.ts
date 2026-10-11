import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./upload-pack-server.ts", import.meta.url));

export interface UploadPackRemote {
  /** The `ext::` URL that starts the test server for the repository directory. */
  readonly url: string;
  /** git options to put before the subcommand. */
  readonly config: readonly string[];
  /** Environment for the git process; the helper passes it on to the server. */
  readonly env: Readonly<Record<string, string>>;
}

/** An argument for git's `ext::` command line: `%` and spaces escaped (git-remote-ext). */
function extArgument(text: string): string {
  return text.replaceAll("%", "%%").replaceAll(" ", "% ");
}

/**
 * How to point stock git at the upload-pack test server for `dir`, for
 * `git clone <url>`, `git fetch <url>` or a remote's URL. By default the
 * client asks for protocol v2 and the server is told so through
 * GIT_PROTOCOL, as git's own server would be; `protocol: 0` leaves both
 * out, which the server refuses. `framing` picks how pack bytes reach the
 * client: framed while streaming (`transport`, the Paid shape) or from
 * stored side-band framed copies (`stored`, the Free shape).
 */
export function uploadPackRemote(
  dir: string,
  options: { readonly framing?: "transport" | "stored"; readonly protocol?: 0 | 2 } = {},
): UploadPackRemote {
  const protocol = options.protocol ?? 2;
  const command = [
    process.execPath,
    "--experimental-transform-types",
    "--no-warnings",
    SERVER,
    "%S",
    dir,
  ].map((part) => (part === "%S" ? part : extArgument(part)));
  return {
    url: `ext::${command.join(" ")}`,
    config: ["-c", "protocol.ext.allow=always", "-c", `protocol.version=${protocol}`],
    env: {
      ...(protocol === 2 ? { GIT_PROTOCOL: "version=2" } : {}),
      FYRDEN_UPLOAD_PACK_FRAMING: options.framing ?? "transport",
    },
  };
}
