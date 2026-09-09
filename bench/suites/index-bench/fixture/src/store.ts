export function createStore(): Map<string, string> {
  return new Map<string, string>();
}

export function readThrough(store: Map<string, string>, key: string): string | null {
  const hit = store.get(key);
  if (hit !== undefined) return hit;
  return null;
}
