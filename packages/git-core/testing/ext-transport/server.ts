/*
 * A git server over stdio for git's `ext::` remote helper
 * (https://git-scm.com/docs/git-remote-ext): git runs
 *
 *   git -c protocol.ext.allow=always push \
 *     "ext::node --experimental-transform-types <main.ts> %S <repo-dir>"
 *
 * and talks to the process's stdin and stdout as it would to
 * `git receive-pack <repo-dir>` over ssh: the server writes its ref
 * advertisement first, then reads the request. `%S` is the service name.
 */

export type GitServiceName = "git-receive-pack" | "git-upload-pack";

export interface GitServiceIo {
  /** The repository directory named on the command line. */
  readonly repoDir: string;
  /** The client's bytes, until it closes its end. */
  readonly input: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
}

export type GitServiceHandler = (io: GitServiceIo) => Promise<void>;

/** Handlers by service; a service without one is refused. */
export type GitServiceHandlers = Partial<Record<GitServiceName, GitServiceHandler>>;

/** Serves one `ext::` invocation: `argv` is `[service, repoDir]`. */
export async function serveExt(
  handlers: GitServiceHandlers,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [service, repoDir] = argv;
  if (!service || !repoDir) throw new Error("usage: main.ts <git-service> <repo-dir>");
  const handler = handlers[service as GitServiceName];
  if (!handler) {
    process.stderr.write(`fatal: ${service} is not served by this test transport\n`);
    process.exitCode = 128;
    return;
  }
  await handler({
    repoDir,
    input: process.stdin as AsyncIterable<Uint8Array>,
    write: (bytes) =>
      new Promise((resolve, reject) =>
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
      ),
  });
}
