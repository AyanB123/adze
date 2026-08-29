import { describe, expect, it } from 'vitest';
import { detectLanguage, validateStructure } from '../src/validate.js';

describe('detectLanguage', () => {
  it('reads the extension from a path in either separator style', () => {
    expect(detectLanguage('src/a/b.ts')).toBe('ts');
    expect(detectLanguage('src\\a\\b.PY')).toBe('py');
    expect(detectLanguage('Makefile')).toBe('');
  });
});

describe('validateStructure — braces languages', () => {
  it('accepts well-formed TypeScript', () => {
    const src = `export function f(a: string): string {\n  return \`v=\${a}\`;\n}\n`;
    expect(validateStructure(src, 'ts')).toMatchObject({ ok: true, validator: 'structural' });
  });

  it('rejects an unclosed brace and reports where it opened', () => {
    const r = validateStructure('function f() {\n  return 1;\n', 'ts');
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unclosed '{'");
    expect(r.line).toBe(1);
  });

  it('rejects a mismatched bracket pair', () => {
    const r = validateStructure('const a = [1, 2);\n', 'ts');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('mismatched bracket');
  });

  it('rejects an unmatched closing bracket', () => {
    const r = validateStructure('const a = 1;\n}\n', 'ts');
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unmatched closing '}'");
  });

  it('rejects an unterminated single-line string', () => {
    const r = validateStructure('const a = "oops;\n', 'ts');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unterminated string');
  });

  it('ignores brackets inside strings', () => {
    expect(validateStructure('const a = "{{{";\n', 'ts').ok).toBe(true);
  });

  it('ignores brackets inside line and block comments', () => {
    expect(validateStructure('// {{{\nconst a = 1;\n', 'ts').ok).toBe(true);
    expect(validateStructure('/* {{{ */\nconst a = 1;\n', 'ts').ok).toBe(true);
  });

  it('rejects an unterminated block comment', () => {
    const r = validateStructure('/* nope\nconst a = 1;\n', 'ts');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unterminated block comment');
  });

  it('handles escaped quotes', () => {
    expect(validateStructure('const a = "he said \\"hi\\"";\n', 'ts').ok).toBe(true);
  });

  it('tracks braces inside template interpolation', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` is the syntax under test
    const src = 'const a = `x${ { k: 1 }.k }y`;\n';
    expect(validateStructure(src, 'ts').ok).toBe(true);
  });

  it('rejects an unterminated template literal', () => {
    const r = validateStructure('const a = `oops;\n', 'ts');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unterminated template literal');
  });

  it('allows a multi-line template literal', () => {
    expect(validateStructure('const a = `line1\nline2`;\n', 'ts').ok).toBe(true);
  });
});

describe('validateStructure — Python', () => {
  it('accepts well-formed Python', () => {
    const src = 'def f(a):\n    """doc"""\n    return a + 1\n';
    expect(validateStructure(src, 'py').ok).toBe(true);
  });

  it('rejects a block opener whose body was dropped', () => {
    // This is the classic edit corruption in an indentation-sensitive language:
    // the colon survives and the body does not.
    const r = validateStructure('def f(a):\nreturn a\n', 'py');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no indented body');
    expect(r.line).toBe(1);
  });

  it('rejects a block opener at end of file', () => {
    const r = validateStructure('def f(a):\n', 'py');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no body');
  });

  it('does not treat a colon inside a comment as a block opener', () => {
    expect(validateStructure('x = 1  # note: this\ny = 2\n', 'py').ok).toBe(true);
  });

  it('handles triple-quoted strings containing colons and brackets', () => {
    const src = 'DOC = """\nif x:\n  {{{\n"""\ny = 1\n';
    expect(validateStructure(src, 'py').ok).toBe(true);
  });

  it('rejects unbalanced parentheses', () => {
    expect(validateStructure('x = f(1, 2\n', 'py').ok).toBe(false);
  });
});

describe('validateStructure — JSON', () => {
  it('accepts a balanced object', () => {
    expect(validateStructure('{"a": [1, 2], "b": {"c": 3}}', 'json').ok).toBe(true);
  });

  it('rejects a truncated object', () => {
    expect(validateStructure('{"a": [1, 2]', 'json').ok).toBe(false);
  });
});

describe('validateStructure — shell', () => {
  it('checks string termination but not brace balance', () => {
    // `case ... esac` and brace expansion make bracket balance a false-positive
    // machine in shell, so only strings are validated.
    expect(validateStructure('case $1 in\n  a) echo hi ;;\nesac\n', 'sh').ok).toBe(true);
    expect(validateStructure("echo 'unterminated\n", 'sh').ok).toBe(false);
  });
});

describe('validateStructure — unknown languages', () => {
  it('declines to guess and says so', () => {
    const r = validateStructure('!!! whatever ???', 'unknownext');
    expect(r.ok).toBe(true);
    expect(r.validator).toBe('none');
    expect(r.message).toContain('no validator');
  });
});
