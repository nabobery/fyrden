import { type FileDiffMetadata, processFile } from "@pierre/diffs";
import { changeType, rendererPatch } from "./patch.js";

/** A file's hunks as the renderer's metadata, named and typed from the API's listing. */
export function fileDiffOf(
  hunks: string,
  file: { path: string; previousPath?: string | undefined; status: string },
  cacheKey: string,
): FileDiffMetadata | undefined {
  const diff = processFile(rendererPatch(hunks), { cacheKey });
  if (!diff) return undefined;
  diff.name = file.path;
  if (file.previousPath !== undefined) diff.prevName = file.previousPath;
  else delete diff.prevName;
  diff.type = changeType(file.status, hunks.length > 0);
  return diff;
}
