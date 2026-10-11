# SHA-1 collision fixtures

Known SHA-1 collisions for the SHA-1DC tests in `../sha1dc.test.ts`. They come
from the `test/` directory of
[cr-marcstevens/sha1collisiondetection](https://github.com/cr-marcstevens/sha1collisiondetection)
at commit `a06f1adbe5522f3c939cd6a3f13d5ec7f4c1a988`, which is distributed
under the MIT licence (Copyright (c) 2017 Marc Stevens, Centrum Wiskunde &
Informatica; Dan Shumow, Microsoft Research). The collisions themselves are
from the SHAttered (2017) and SHA-1 is a Shambles (2020) attacks.

| File | Source | Bytes |
|---|---|---|
| `shattered-1-first-320.bin` | first 320 bytes of `test/shattered-1.pdf` (422,435 bytes) | 320 |
| `shattered-2-first-320.bin` | first 320 bytes of `test/shattered-2.pdf` (422,435 bytes) | 320 |
| `sha-mbles-1.bin` | `test/sha-mbles-1.bin`, unchanged | 640 |
| `sha-mbles-2.bin` | `test/sha-mbles-2.bin`, unchanged | 640 |

`ubc-dv-inputs.bin` (3,840 bytes) is not from upstream. It was generated for
these tests: for each of the 32 disturbance vectors in `SHA1_DVS` order, an
expanded message whose words W[35..64] pass every unavoidable bit condition
of that vector in the reference `ubc_check` (from the commit above), stored as
30 big-endian 32-bit words, so vector `d` starts at byte `d * 120`. The words
were found by a seeded search (xorshift32, seed `0x5eed1234`): random words,
then random flips of bits 0 to 7 and 28 to 30 kept whenever more of the
vector's conditions held, until all did; the reference `ubc_check` then
confirmed the vector's mask bit for each. The tests check the port's masks
around these inputs against checksums the reference produced for the same
flips.

The two SHAttered files are **truncated**: the PDFs differ only in their two
near-collision blocks (bytes 192 to 319), so the first 320 bytes are already
a full collision (plain SHA-1 `f92d74e3874587aaf443d1db961d4e26dde13e9c` for
both) and keep the 845 KB of PDF out of the repository.

Verified (measured, 2026-10-11) with the reference `sha1dcsum` built from
that commit: it reports `*coll*` for all four files here, and for no prefix
of the SHAttered PDFs shorter than 320 bytes (192 and 256 bytes were tried).
