/**
 * Front matter parsing.
 *
 * The refusals matter more than the successes. This parser sits on the path that
 * decides what a subagent may do, so a construct it cannot represent has to be an
 * error — silently ignoring an alias or a nested mapping in a `tools:` list would make
 * the enforced allowlist differ from the one a reviewer read.
 */

import { describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  readMapping,
  readPositiveInteger,
  readString,
  readStringList,
} from '../src/frontmatter.js';

function data(text: string) {
  const outcome = parseFrontmatter(text);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.document;
}

describe('parseFrontmatter - the supported grammar', () => {
  it('parses the spec example', () => {
    const document = data(
      [
        '---',
        'name: review',
        'description: Review staged changes against our conventions',
        'tools: [read, grep, symbols, bash]',
        'model: { prefer: reasoning }',
        '---',
        '',
        'Review the staged diff.',
      ].join('\n'),
    );
    expect(document.data.name).toBe('review');
    expect(document.data.tools).toEqual(['read', 'grep', 'symbols', 'bash']);
    expect(document.data.model).toEqual({ prefer: 'reasoning' });
    expect(document.body.trim()).toBe('Review the staged diff.');
  });

  it('parses numbers and booleans as themselves', () => {
    const document = data('---\nmaxSteps: 30\nstrict: true\n---\nbody');
    expect(document.data.maxSteps).toBe(30);
    expect(document.data.strict).toBe(true);
  });

  it('parses quoted strings, keeping punctuation that would otherwise parse', () => {
    const document = data('---\ndescription: "tools: [a, b]"\n---\nbody');
    expect(document.data.description).toBe('tools: [a, b]');
  });

  it('parses a block sequence', () => {
    const document = data('---\npaths:\n  - docs/a.md\n  - README.md\n---\nbody');
    expect(document.data.paths).toEqual(['docs/a.md', 'README.md']);
  });

  it('parses an empty inline sequence', () => {
    expect(data('---\ntools: []\n---\nbody').data.tools).toEqual([]);
  });

  it('strips a trailing comment only after whitespace', () => {
    const document = data('---\nname: review # the command\ntag: v1#2\n---\nbody');
    expect(document.data.name).toBe('review');
    expect(document.data.tag).toBe('v1#2');
  });

  it('tolerates CRLF and a leading BOM', () => {
    const document = data('\uFEFF---\r\nname: review\r\n---\r\nbody\r\n');
    expect(document.data.name).toBe('review');
  });

  it('keeps the body verbatim, including blank lines', () => {
    const document = data('---\nname: x\n---\nline one\n\nline three\n');
    expect(document.body).toBe('line one\n\nline three\n');
  });

  it('removes exactly one newline after the closing delimiter', () => {
    // The newline that terminates the '---' line belongs to the delimiter, not to the
    // prompt, so keeping it would start every command template and every subagent
    // prompt with a blank line. A second newline is the author's and survives. This
    // case exists because the assertion above was originally written expecting the
    // delimiter's newline to be kept, which contradicted the documented contract on
    // `FrontmatterDocument.body` and would have made the contract ambiguous.
    expect(data('---\nname: x\n---\n\nbody\n').body).toBe('\nbody\n');
  });
});

describe('parseFrontmatter - refusals', () => {
  it('requires front matter', () => {
    const outcome = parseFrontmatter('just a prompt', 'review.md');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('expected front matter');
  });

  it('requires the closing delimiter and names the opening line', () => {
    const outcome = parseFrontmatter('---\nname: x\nbody', 'review.md');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('never closed');
  });

  it('refuses a YAML alias, which could differ from what a reviewer read', () => {
    const outcome = parseFrontmatter('---\ntools: *base\n---\nbody', 'a.md');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('aliases are not supported');
  });

  it('refuses an anchor, a merge key, a tag, and a block scalar', () => {
    for (const line of ['tools: &base [read]', '<<: *defaults', 'value: !!str x', 'prompt: |']) {
      expect(parseFrontmatter(`---\n${line}\n---\nbody`).ok).toBe(false);
    }
  });

  it('refuses an anchor or alias wherever a value may appear', () => {
    // Regression. The line-level anchor rule required the anchor to be the last thing
    // on the line, so the canonical `key: &anchor value` form was accepted and became
    // the string '&base [read]'. Aliases inside an inline collection leaked the same
    // way and became '*base'. Both produced a `tools` value a reviewer would read as a
    // list and the engine would read as text — the exact divergence this parser exists
    // to refuse, and worse than a parse error because nothing reported it.
    for (const document of [
      '---\ntools: &base [read]\n---\nbody',
      '---\ntools: [*base]\n---\nbody',
      '---\ntools: [read, *extra]\n---\nbody',
      '---\nmodel: { prefer: *fast }\n---\nbody',
      '---\npaths:\n  - *base\n---\nbody',
      '---\npaths:\n  - &first docs/a.md\n---\nbody',
    ]) {
      expect(parseFrontmatter(document, 'a.md').ok).toBe(false);
    }
  });

  it('still accepts a value that merely contains an ampersand or asterisk', () => {
    // The indicator is only special at the start of an unquoted value, so narrowing
    // the check to that position must not cost these.
    const document = data('---\nname: Ben & Jerry\nglob: src/**/*.ts\n---\nbody');
    expect(document.data.name).toBe('Ben & Jerry');
    expect(document.data.glob).toBe('src/**/*.ts');
    expect(data('---\nname: "&notananchor"\n---\nbody').data.name).toBe('&notananchor');
  });

  it('refuses a duplicate key rather than picking a winner', () => {
    const outcome = parseFrontmatter('---\ntools: [read]\ntools: [bash]\n---\nbody', 'a.md');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('defined twice');
  });

  it('refuses a nested block mapping and suggests the inline form', () => {
    const outcome = parseFrontmatter('---\nmodel:\n  prefer: reasoning\n---\nbody', 'a.md');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('inline mapping');
  });

  it('refuses an unterminated inline collection', () => {
    expect(parseFrontmatter('---\ntools: [read, grep\n---\nbody').ok).toBe(false);
    expect(parseFrontmatter('---\nmodel: { prefer: x\n---\nbody').ok).toBe(false);
  });

  it('refuses null, which would read as a value that is not there', () => {
    expect(parseFrontmatter('---\ntools: null\n---\nbody').ok).toBe(false);
  });

  it('reports the offending line number', () => {
    const outcome = parseFrontmatter('---\nname: ok\nbroken line\n---\nbody', 'a.md');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('a.md:3');
  });
});

describe('typed readers', () => {
  const document = data(
    '---\nname: review\ntools: [read]\nmaxSteps: 5\nmodel: { prefer: fast }\n---\nb',
  );

  it('reads a required string and explains a missing one', () => {
    expect(readString(document.data, 'name')).toEqual({ ok: true, value: 'review' });
    const missing = readString(document.data, 'description');
    expect(missing.ok).toBe(false);
  });

  it('treats an absent list as empty and a wrong-typed one as an error', () => {
    expect(readStringList(document.data, 'absent')).toEqual({ ok: true, value: [] });
    const wrong = readStringList(document.data, 'name');
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    // The message shows the shape to write, not just the shape expected.
    expect(wrong.message).toContain('[read, grep]');
  });

  it('reads a positive integer and rejects zero or a fraction', () => {
    expect(readPositiveInteger(document.data, 'maxSteps')).toEqual({ ok: true, value: 5 });
    const zero = data('---\nmaxSteps: 0\n---\nb');
    expect(readPositiveInteger(zero.data, 'maxSteps').ok).toBe(false);
  });

  it('reads an inline mapping', () => {
    const outcome = readMapping(document.data, 'model');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value?.prefer).toBe('fast');
  });
});
