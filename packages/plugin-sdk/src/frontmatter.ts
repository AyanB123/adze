/**
 * Front matter for slash commands and subagent definitions.
 *
 * A deliberately small YAML subset, parsed here rather than with a YAML library.
 * Two reasons, and the second is the real one.
 *
 * The stated reason is scope: the spec's front matter is `name`, `description`,
 * `tools: [read, grep]`, `model: { prefer: reasoning }`, and `maxSteps: 30`. That
 * is scalars, one level of inline collection, and block sequences — a grammar
 * small enough to specify in this comment.
 *
 * The real reason is that front matter is untrusted input on the path that decides
 * what a subagent is allowed to do. A general YAML parser accepts anchors, aliases,
 * merge keys, and implicit type coercion, and every one of those is a way for the
 * `tools:` list a reviewer reads to differ from the list that is enforced. A parser
 * that cannot express an alias cannot be tricked with one.
 *
 * ## The grammar
 *
 * ```yaml
 * name: review                      # bare scalar, trailing comment stripped
 * description: "Review staged work"  # single or double quoted
 * tools: [read, grep, symbols]       # inline sequence
 * model: { prefer: reasoning }       # inline mapping, one level
 * maxSteps: 30                       # number
 * strict: true                       # boolean
 * paths:                             # block sequence
 *   - docs/**\/*.md
 *   - README.md
 * ```
 *
 * Anything else — nested block mappings, multi-line scalars (`|`, `>`), anchors,
 * aliases, tags, multiple documents — is a parse error naming the line. Refusing is
 * the point: silently ignoring a construct in a `tools:` list would produce a
 * narrower or wider allowlist than the author wrote.
 */

export type FrontmatterScalar = string | number | boolean;
export type FrontmatterValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | Readonly<Record<string, FrontmatterScalar>>;

export interface FrontmatterDocument {
  readonly data: Readonly<Record<string, FrontmatterValue>>;
  /** Everything after the closing delimiter, with one leading newline removed. */
  readonly body: string;
}

export type FrontmatterOutcome =
  | { readonly ok: true; readonly document: FrontmatterDocument }
  | { readonly ok: false; readonly message: string };

const DELIMITER = '---';

/**
 * Split and parse a front-matter document.
 *
 * Front matter is required rather than optional. A command file without it has no
 * `name`, so it cannot be invoked; reporting that as a missing delimiter is more
 * useful than reporting it later as a missing field.
 */
export function parseFrontmatter(text: string, label = 'document'): FrontmatterOutcome {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  let cursor = 0;
  while (cursor < lines.length && (lines[cursor] ?? '').trim().length === 0) cursor += 1;

  if ((lines[cursor] ?? '').trim() !== DELIMITER) {
    return {
      ok: false,
      message:
        `${label}: expected front matter. The file must open with a '---' line, then ` +
        `YAML keys, then a closing '---', then the prompt template.`,
    };
  }
  const openedAt = cursor;
  cursor += 1;

  const yamlLines: { readonly text: string; readonly number: number }[] = [];
  let closed = false;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? '';
    if (line.trim() === DELIMITER) {
      closed = true;
      cursor += 1;
      break;
    }
    yamlLines.push({ text: line, number: cursor + 1 });
  }

  if (!closed) {
    return {
      ok: false,
      message: `${label}: front matter opened on line ${openedAt + 1} was never closed with '---'.`,
    };
  }

  const parsed = parseBlock(yamlLines, label);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    document: { data: parsed.data, body: lines.slice(cursor).join('\n') },
  };
}

type BlockOutcome =
  | { readonly ok: true; readonly data: Readonly<Record<string, FrontmatterValue>> }
  | { readonly ok: false; readonly message: string };

function parseBlock(
  lines: readonly { readonly text: string; readonly number: number }[],
  label: string,
): BlockOutcome {
  const data: Record<string, FrontmatterValue> = {};
  let index = 0;

  while (index < lines.length) {
    const entry = lines[index];
    if (entry === undefined) break;
    const raw = entry.text;
    const trimmed = raw.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      index += 1;
      continue;
    }

    const unsupported = unsupportedConstruct(trimmed);
    if (unsupported !== undefined) {
      return { ok: false, message: `${label}:${entry.number}: ${unsupported}` };
    }

    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      return {
        ok: false,
        message:
          `${label}:${entry.number}: unexpected indentation. Only top-level keys and ` +
          `block-sequence '- ' items under a key are supported.`,
      };
    }

    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      return {
        ok: false,
        message: `${label}:${entry.number}: expected 'key: value'. Found '${trimmed}'.`,
      };
    }

    const key = trimmed.slice(0, colon).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      return {
        ok: false,
        message: `${label}:${entry.number}: '${key}' is not a usable key name.`,
      };
    }
    if (key in data) {
      return {
        ok: false,
        message:
          `${label}:${entry.number}: '${key}' is defined twice. Which one wins is exactly ` +
          `the kind of thing a reviewer would not notice, so it is an error.`,
      };
    }

    const inline = trimmed.slice(colon + 1).trim();
    if (inline.length > 0) {
      const value = parseInlineValue(inline);
      if (!value.ok) return { ok: false, message: `${label}:${entry.number}: ${value.message}` };
      data[key] = value.value;
      index += 1;
      continue;
    }

    // A key with nothing after the colon: either a block sequence, or nothing.
    const items: FrontmatterScalar[] = [];
    let scan = index + 1;
    for (; scan < lines.length; scan += 1) {
      const candidate = lines[scan];
      if (candidate === undefined) break;
      const candidateTrimmed = candidate.text.trim();
      if (candidateTrimmed.length === 0 || candidateTrimmed.startsWith('#')) continue;
      if (!candidateTrimmed.startsWith('- ') && candidateTrimmed !== '-') break;
      if (candidateTrimmed === '-') {
        return {
          ok: false,
          message: `${label}:${candidate.number}: a sequence item must have a value.`,
        };
      }
      const item = parseScalar(candidateTrimmed.slice(2).trim());
      if (!item.ok) {
        return { ok: false, message: `${label}:${candidate.number}: ${item.message}` };
      }
      items.push(item.value);
    }

    if (items.length === 0) {
      return {
        ok: false,
        message:
          `${label}:${entry.number}: '${key}' has no value. Nested mappings are not ` +
          `supported; use an inline mapping such as '${key}: { prefer: reasoning }'.`,
      };
    }
    data[key] = items;
    index = scan;
  }

  return { ok: true, data };
}

function unsupportedConstruct(trimmed: string): string | undefined {
  // Only the degenerate case where a line *begins* with an anchor is caught here.
  // An anchor in value position (`tools: &base [read]`) is caught in `parseScalar`,
  // which is the only place that knows the value is unquoted and in node position.
  // A line-level regex cannot tell `tools: &base [read]` from
  // `description: "a: &b"`, and the earlier one here matched neither: it required
  // the anchor to be the last thing on the line, so the canonical form — where the
  // anchor precedes the value it names — was accepted as an ordinary string.
  if (trimmed.startsWith('&')) {
    return 'YAML anchors are not supported. Write the value out.';
  }
  if (/:\s*\*[A-Za-z0-9_-]+\s*$/.test(trimmed)) {
    return 'YAML aliases are not supported: an alias lets the enforced value differ from the one a reviewer reads.';
  }
  if (/:\s*[|>][-+]?\s*$/.test(trimmed)) {
    return 'block scalars (| and >) are not supported. Use a quoted single-line string.';
  }
  if (trimmed.startsWith('<<:')) return 'YAML merge keys are not supported.';
  if (trimmed.startsWith('%')) return 'YAML directives are not supported.';
  if (/:\s*![A-Za-z!]/.test(trimmed)) return 'YAML tags are not supported.';
  return undefined;
}

type ValueOutcome =
  | { readonly ok: true; readonly value: FrontmatterValue }
  | { readonly ok: false; readonly message: string };

type ScalarOutcome =
  | { readonly ok: true; readonly value: FrontmatterScalar }
  | { readonly ok: false; readonly message: string };

function parseInlineValue(raw: string): ValueOutcome {
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) {
      return { ok: false, message: 'an inline sequence must close with "]" on the same line.' };
    }
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return { ok: true, value: [] };
    const items: FrontmatterScalar[] = [];
    for (const part of splitTopLevel(inner)) {
      const scalar = parseScalar(part.trim());
      if (!scalar.ok) return scalar;
      items.push(scalar.value);
    }
    return { ok: true, value: items };
  }

  if (raw.startsWith('{')) {
    if (!raw.endsWith('}')) {
      return { ok: false, message: 'an inline mapping must close with "}" on the same line.' };
    }
    const inner = raw.slice(1, -1).trim();
    const record: Record<string, FrontmatterScalar> = {};
    if (inner.length === 0) return { ok: true, value: record };
    for (const part of splitTopLevel(inner)) {
      const colon = part.indexOf(':');
      if (colon <= 0) {
        return { ok: false, message: `'${part.trim()}' is not 'key: value' inside a mapping.` };
      }
      const key = part.slice(0, colon).trim();
      const scalar = parseScalar(part.slice(colon + 1).trim());
      if (!scalar.ok) return scalar;
      record[key] = scalar.value;
    }
    return { ok: true, value: record };
  }

  return parseScalar(raw);
}

/** Split on commas that are not inside quotes or brackets. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let start = 0;

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

function parseScalar(raw: string): ScalarOutcome {
  if (raw.length === 0) return { ok: false, message: 'expected a value.' };

  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    if (raw.length < 2 || !raw.endsWith(quote)) {
      return { ok: false, message: `unterminated quoted string: ${raw}` };
    }
    return { ok: true, value: raw.slice(1, -1) };
  }

  // YAML node indicators. `&name` declares an anchor, `*name` refers to one, and both
  // are refused for the reason at the top of this file: they let the value that is
  // enforced differ from the value a reviewer read. The check belongs here rather than
  // on the raw line because this is the only point that knows a value is both unquoted
  // and in node position, so it also covers the positions a line-level regex cannot
  // see — an anchor or alias inside an inline sequence (`tools: [*base]`), inside an
  // inline mapping, or as a block-sequence item. Those parsed as the strings '*base'
  // and '&base [read]' before, which is the silent divergence this module exists to
  // prevent. A value that genuinely starts with '&' or '*' is written quoted, and the
  // branch above has already returned for that case.
  if (raw.startsWith('&')) {
    return { ok: false, message: 'YAML anchors are not supported. Write the value out.' };
  }
  if (raw.startsWith('*')) {
    return {
      ok: false,
      message:
        'YAML aliases are not supported: an alias lets the enforced value differ from the one a reviewer reads.',
    };
  }

  // Strip a trailing comment only when a space precedes the '#', so a value such
  // as `tag: v1#2` survives. YAML requires the space too.
  const commented = raw.replace(/\s+#.*$/, '').trim();
  if (commented.length === 0) return { ok: false, message: 'expected a value before the comment.' };

  if (commented === 'true') return { ok: true, value: true };
  if (commented === 'false') return { ok: true, value: false };
  if (commented === 'null' || commented === '~') {
    return {
      ok: false,
      message: 'null is not a usable value here. Omit the key instead.',
    };
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(commented)) {
    return { ok: true, value: Number(commented) };
  }
  return { ok: true, value: commented };
}

// ---------------------------------------------------------------------------
// Typed readers
// ---------------------------------------------------------------------------

/**
 * Readers rather than a schema, because the failure message matters more than the
 * shape check: a subagent whose `tools` was written as a string instead of a list
 * has a real allowlist problem, and "expected array" does not say what to write.
 */
export function readString(
  data: Readonly<Record<string, FrontmatterValue>>,
  key: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = data[key];
  if (value === undefined) return { ok: false, message: `'${key}' is required.` };
  if (typeof value !== 'string') {
    return { ok: false, message: `'${key}' must be text, not ${describe(value)}.` };
  }
  if (value.trim().length === 0) return { ok: false, message: `'${key}' must not be empty.` };
  return { ok: true, value };
}

export function readStringList(
  data: Readonly<Record<string, FrontmatterValue>>,
  key: string,
): { ok: true; value: readonly string[] } | { ok: false; message: string } {
  const value = data[key];
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      message: `'${key}' must be a list, for example '${key}: [read, grep]'. Found ${describe(value)}.`,
    };
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, message: `every entry in '${key}' must be text.` };
    }
    items.push(item);
  }
  return { ok: true, value: items };
}

export function readPositiveInteger(
  data: Readonly<Record<string, FrontmatterValue>>,
  key: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const value = data[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `'${key}' must be a positive whole number.` };
  }
  return { ok: true, value };
}

export function readMapping(
  data: Readonly<Record<string, FrontmatterValue>>,
  key: string,
):
  | { ok: true; value: Readonly<Record<string, FrontmatterScalar>> | undefined }
  | { ok: false; message: string } {
  const value = data[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      message: `'${key}' must be an inline mapping, for example '${key}: { prefer: reasoning }'.`,
    };
  }
  return { ok: true, value: value as Readonly<Record<string, FrontmatterScalar>> };
}

function describe(value: FrontmatterValue): string {
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return `${typeof value} '${String(value)}'`;
}
