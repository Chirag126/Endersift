/**
 * CI guard: `.env.example` must list exactly the variables in ENV_SPEC,
 * secret values must be blank, and no secret may be exposed to the browser.
 */
import { readFileSync } from 'node:fs';
import { checkEnvExample, checkSpec } from './lib/env-example.ts';

const problems = [...checkSpec(), ...checkEnvExample(readFileSync('.env.example', 'utf8'))];

if (problems.length === 0) {
  console.log('env:example:check - .env.example matches ENV_SPEC.');
} else {
  console.error('env:example:check - problems found:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
}
