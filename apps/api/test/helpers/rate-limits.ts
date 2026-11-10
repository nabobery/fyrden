/**
 * Spending a rate limiter's allowance through real requests. The local
 * limiter counts in fixed one-minute windows aligned to the wall clock, so a
 * run of requests can straddle one boundary: the first `limit` always pass,
 * and at most `2 × limit` can pass across a boundary (`limit` in each
 * window). Request `2 × limit + 1` is therefore refused unless the requests
 * span more than a minute. Sent one at a time until refused, or past that.
 */
export async function untilThrottled(
  send: (i: number) => Promise<Response>,
  limit: number,
): Promise<{ passed: number[]; throttled: Response | undefined }> {
  const passed: number[] = [];
  for (let i = 0; i <= 2 * limit; i++) {
    const response = await send(i);
    if (response.status === 429) return { passed, throttled: response };
    passed.push(response.status);
  }
  return { passed, throttled: undefined };
}
