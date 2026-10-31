/*
 * Which sources search may show, by recovery generation. A recovery raises
 * the read model's generation (`search_index_state.recovery_gen`): every
 * source with a row is hidden at once, until a whole reconciliation started
 * under the new generation makes it visible again (`visible_gen`); a source
 * with no row had nothing restored, and is visible. Coverage
 * (`index_covered`) is reported apart: a source may be visible while a
 * repair is asked for.
 */

/** The read model's recovery generation. */
export const RECOVERY_GEN = "(SELECT recovery_gen FROM search_index_state WHERE id = 1)";

/** SQL true while the source `repo` (an expression) may be shown. */
export const SOURCE_VISIBLE = (repo: string) =>
  `coalesce((SELECT s.visible_gen FROM search_sources s WHERE s.repo_id = ${repo}),
    ${RECOVERY_GEN}) = ${RECOVERY_GEN}`;
