const EMPTY = new Uint8Array(0);

/**
 * Stores `chunks` as one R2 object at `key` without joining them: they go
 * through a `FixedLengthStream` of their total length, each dropped from
 * `chunks` once written, so no second, joined copy is ever held.
 */
export async function putChunks(
  bucket: R2Bucket,
  key: string,
  chunks: Uint8Array[],
): Promise<R2Object> {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const { readable, writable } = new FixedLengthStream(length);
  const writer = writable.getWriter();
  const feed = async () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as Uint8Array;
      chunks[i] = EMPTY;
      await writer.write(chunk);
    }
    await writer.close();
  };
  const [object] = await Promise.all([bucket.put(key, readable), feed()]);
  if (!object) throw new Error(`R2 did not store ${key}`);
  return object;
}
