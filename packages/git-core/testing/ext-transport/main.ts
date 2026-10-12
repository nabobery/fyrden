// Entry point of the `ext::` test transport. Run it with Node's TypeScript
// support (Node 24): node --experimental-transform-types main.ts <service> <repo-dir>
// (transform, not just strip, because some git-core classes use parameter
// properties). git-core imports its modules with ".js" names, so a resolve
// hook maps a missing "x.js" to "x.ts".
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
      const parent = context.parentURL;
      if (parent) {
        const asTs = new URL(`${specifier.slice(0, -3)}.ts`, parent);
        const asJs = new URL(specifier, parent);
        if (!existsSync(fileURLToPath(asJs)) && existsSync(fileURLToPath(asTs))) {
          return next(asTs.href, context);
        }
      }
    }
    return next(specifier, context);
  },
});

const { serveExt } = await import("./server.js");
const { receivePackHandler } = await import("./receive-pack-handler.js");

// Upload-pack is served when a sibling module provides it (`upload-pack-handler.ts`
// exporting `uploadPackHandler`).
const uploadPackModule = new URL("./upload-pack-handler.ts", import.meta.url);
const uploadPack = existsSync(fileURLToPath(uploadPackModule))
  ? (
      (await import(uploadPackModule.href)) as {
        uploadPackHandler?: import("./server.js").GitServiceHandler;
      }
    ).uploadPackHandler
  : undefined;

try {
  await serveExt({
    "git-receive-pack": receivePackHandler,
    ...(uploadPack ? { "git-upload-pack": uploadPack } : {}),
  });
} catch (error) {
  process.stderr.write(
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 128;
}
