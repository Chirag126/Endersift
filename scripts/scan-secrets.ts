/**
 * Scan tracked or staged files for secrets.
 *
 *   node scripts/scan-secrets.ts --all      every file tracked by git (CI, manual)
 *   node scripts/scan-secrets.ts --staged   staged content only (pre-commit hook)
 *
 * Exits 1 when anything is found. Findings show file, line and rule, never the secret.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { looksBinary, scanText, type SecretFinding } from './lib/secret-patterns.ts';

const MAX_BYTES = 1_000_000;

function git(args: string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(mode: 'all' | 'staged'): string[] {
  const out =
    mode === 'all'
      ? git(['ls-files', '-z'])
      : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return out
    .toString('utf8')
    .split('\0')
    .filter((f) => f !== '');
}

function readContent(file: string, mode: 'all' | 'staged'): Buffer | null {
  if (mode === 'staged') return git(['show', `:${file}`]);
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    return readFileSync(file);
  } catch {
    return null; // deleted in working tree but still tracked
  }
}

function main(): void {
  const mode = process.argv.includes('--staged') ? 'staged' : 'all';
  const files = listFiles(mode);
  const results: { file: string; findings: SecretFinding[] }[] = [];

  for (const file of files) {
    const content = readContent(file, mode);
    if (content === null || content.length > MAX_BYTES || looksBinary(content)) continue;
    const findings = scanText(content.toString('utf8'));
    if (findings.length > 0) results.push({ file, findings });
  }

  if (results.length === 0) {
    console.log(`secrets:scan (${mode}) - ${files.length} files scanned, no findings.`);
    return;
  }

  console.error(`secrets:scan (${mode}) - possible secrets found:`);
  for (const { file, findings } of results) {
    for (const f of findings) console.error(`  ${file}:${f.line}  [${f.ruleId}]  ${f.preview}`);
  }
  console.error(
    '\nRemove the secret, move it to your local .env (never committed), and rotate it if it was ever pushed.',
  );
  process.exitCode = 1;
}

main();
