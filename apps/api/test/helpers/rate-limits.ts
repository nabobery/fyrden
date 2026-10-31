/**
 * Spending a rate limiter's allowance through real requests. The local
 * limiter counts in windows aligned to the wall clock, so a run of requests
 * can straddle two of them: the first `limit` always pass, and the request
 * refused comes after `limit` of them (one window) or fewer than
 * `2 × limit` (two). Sent one at a time until refused, or past both.
 */
export async function untilThrottled(
  send: (i: number) => Promise<Response>,
  limit: number,
): Promise<{ passed: number[]; throttled: Response | undefined }> {
  const passed: number[] = [];
  for (let i = 0; i < 2 * limit; i++) {
    const response = await send(i);
    if (response.status === 429) return { passed, throttled: response };
    passed.push(response.status);
  }
  return { passed, throttled: undefined };
}
