/**
 * Identifier generation.
 *
 * Ids appear in trajectory logs, which are artifacts benchmark claims are checked
 * against, so two properties matter more than uniqueness-at-scale: they sort in
 * creation order, and a run can be made to produce the same ids twice. The second
 * is why this is an injectable factory rather than a bare `randomUUID()` call —
 * a replay that differs from the original only by id is a diff nobody can read.
 */

/** Monotonic-per-prefix id source. */
export type IdFactory = (prefix: string) => string;

/**
 * Random ids, prefixed and time-ordered.
 *
 * `Date.now()` in base-36 leads so a lexical sort is a chronological sort, which
 * makes a directory of trajectory files readable without parsing them.
 */
export function randomIdFactory(): IdFactory {
  let counter = 0;
  return (prefix: string): string => {
    counter += 1;
    const stamp = Date.now().toString(36);
    const noise = Math.floor(Math.random() * 0xffffff)
      .toString(36)
      .padStart(4, '0');
    return `${prefix}_${stamp}${counter.toString(36)}${noise}`;
  };
}

/**
 * Deterministic ids: `prefix_1`, `prefix_2`, …
 *
 * For tests and for replay. Not for production, where two engines sharing a
 * store would collide immediately.
 */
export function sequentialIdFactory(): IdFactory {
  const counters = new Map<string, number>();
  return (prefix: string): string => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}
