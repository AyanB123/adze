export function parseDuration(input) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(input).trim());
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  return n * 3600 * 1000;
}
