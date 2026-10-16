/** Where a Markdown file is: its repository's page, the ref (encoded) and its directory. */
export interface MarkdownPlace {
  /** `/{owner}/{repo}`. */
  readonly base: string;
  /** The ref as the file's own URL has it (encoded). */
  readonly ref: string;
  /** The file's directory in the repository, "" at its top. */
  readonly dir: string;
}

/** The directory of a file's path ("" at the top). */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
