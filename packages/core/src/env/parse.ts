/**
 * Minimal, dependency-free .env parser.
 *
 * Supports: KEY=value, optional `export ` prefix, single/double-quoted values,
 * blank lines, full-line comments and ` #` inline comments after unquoted values.
 * Duplicate keys are reported rather than silently overwritten.
 */

export interface DotenvEntry {
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

export interface DotenvParseResult {
  readonly entries: readonly DotenvEntry[];
  readonly errors: readonly string[];
}

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function parseDotenv(text: string): DotenvParseResult {
  const entries: DotenvEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push(`line ${lineNo}: expected KEY=VALUE`);
      return;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) {
      errors.push(`line ${lineNo}: invalid key name "${key}"`);
      return;
    }

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1);
      if (close === -1) {
        errors.push(`line ${lineNo}: unterminated quoted value for ${key}`);
        return;
      }
      value = value.slice(1, close);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (seen.has(key)) {
      errors.push(`line ${lineNo}: duplicate key ${key}`);
      return;
    }
    seen.add(key);
    entries.push({ key, value, line: lineNo });
  });

  return { entries, errors };
}

export function dotenvToRecord(result: DotenvParseResult): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of result.entries) record[entry.key] = entry.value;
  return record;
}
