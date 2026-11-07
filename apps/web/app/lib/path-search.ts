/**
 * How many paths the finder shows at once. Measured in Chromium at 4x CPU throttling, drawing
 * a whole new list: 3 ms for 100 rows beside a search's 31 ms over 200,000 paths, 32 ms for
 * 1,000. About 15 rows fit on screen, so past this it is quicker to type more.
 */
export const FINDER_SHOWN = 100;

/** The first paths matching a query, and how many match in all. */
export interface PathMatches {
  readonly shown: readonly string[];
  readonly total: number;
}

/** A path list searched by case-insensitive substring. It grows as pages arrive. */
export class PathIndex {
  readonly #paths: string[] = [];
  readonly #folded: string[] = [];

  get size(): number {
    return this.#paths.length;
  }

  add(paths: readonly string[]): void {
    for (const path of paths) {
      this.#paths.push(path);
      this.#folded.push(path.toLowerCase());
    }
  }

  clear(): void {
    this.#paths.length = 0;
    this.#folded.length = 0;
  }

  /** Every path counts towards `total`, whatever `limit` shows: nothing stops the scan early. */
  search(query: string, limit: number): PathMatches {
    const wanted = query.trim().toLowerCase();
    if (wanted === "") return { shown: this.#paths.slice(0, limit), total: this.#paths.length };
    const shown: string[] = [];
    let total = 0;
    const folded = this.#folded;
    for (let i = 0; i < folded.length; i++) {
      if (!(folded[i] as string).includes(wanted)) continue;
      if (total < limit) shown.push(this.#paths[i] as string);
      total++;
    }
    return { shown, total };
  }
}
