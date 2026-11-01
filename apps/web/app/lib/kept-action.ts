import { useRef } from "react";
import { useActionData, useLocation } from "react-router";

/**
 * The page's last action answer, kept through its own rereads (React
 * Router drops it when a page is read again, as live hints do) until the
 * page goes to another location: a submission's answer replaces it, a
 * navigation clears it.
 */
export function useKeptActionData<T>(): ReturnType<typeof useActionData<T>> {
  const answer = useActionData<T>();
  const { key } = useLocation();
  const kept = useRef({ answer, key });
  if (answer !== undefined) kept.current = { answer, key };
  else if (kept.current.key !== key) kept.current = { answer: undefined, key };
  return kept.current.answer;
}
