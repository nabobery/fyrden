import { registerHooks } from "node:module";

/*
 * Entry point of the upload-pack test server, for git's `ext::` remote
 * helper (see `uploadPackRemote`):
 *
 *   node --experimental-transform-types --no-warnings upload-pack-server.ts <service> <dir>
 *
 * Node runs the TypeScript sources directly. They import each other with
 * `.js` specifiers (the TypeScript convention), so a resolve hook maps a
 * relative `.js` import that does not exist to its `.ts` source. The flag
 * is needed because a few sources use parameter properties, which plain
 * type stripping does not accept (Node 24 docs, "Modules: TypeScript").
 */
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

const [service, dir] = process.argv.slice(2);
if (!service || !dir) {
  process.stderr.write("usage: upload-pack-server.ts <service> <repository directory>\n");
  process.exit(2);
}

const { serveUploadPack } = await import("./upload-pack-serve.js");

async function write(bytes: Uint8Array): Promise<void> {
  if (!process.stdout.write(bytes)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
  }
}

try {
  const code = await serveUploadPack(service, dir, {
    input: process.stdin,
    write,
    env: process.env,
  });
  process.stdout.end(() => process.exit(code));
} catch (error) {
  process.stderr.write(`upload-pack test server: ${(error as Error).stack ?? error}\n`);
  process.exit(1);
}
