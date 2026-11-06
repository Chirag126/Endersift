import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { EnvVarSpec } from '../../packages/core/src/index.ts';
import { checkEnvExample, checkSpec } from '../lib/env-example.ts';

const spec: EnvVarSpec[] = [
  { name: 'A_PUBLIC', group: 'core', required: true, secret: false, default: 'x', description: '' },
  { name: 'A_API_KEY', group: 'zg', required: true, secret: true, description: '' },
];

describe('checkSpec', () => {
  it('passes for the real project spec', () => {
    assert.deepEqual(checkSpec(), []);
  });

  it('rejects secrets exposed through the browser prefix', () => {
    const problems = checkSpec([
      { name: 'VITE_ZG_API_KEY', group: 'web', required: false, secret: true, description: '' },
    ]);
    assert.ok(problems.some((p) => p.includes('public VITE_ prefix')));
    assert.ok(problems.some((p) => p.includes('bundled into the browser')));
  });

  it('rejects credential-named variables not marked secret, and secret defaults', () => {
    const problems = checkSpec([
      { name: 'X_PRIVATE_KEY', group: 'core', required: true, secret: false, description: '' },
      {
        name: 'Y_SECRET',
        group: 'core',
        required: true,
        secret: true,
        default: 'z',
        description: '',
      },
    ]);
    assert.ok(problems.some((p) => p.startsWith('X_PRIVATE_KEY')));
    assert.ok(problems.some((p) => p.startsWith('Y_SECRET')));
  });
});

describe('checkEnvExample template rules', () => {
  const ruleSpec: EnvVarSpec[] = [
    {
      name: 'WITH_DEFAULT',
      group: 'core',
      required: true,
      secret: false,
      default: 'x',
      description: '',
    },
    { name: 'NO_DEFAULT', group: 'hedera', required: true, secret: false, description: '' },
  ];

  it('rejects a real value for a variable without a default', () => {
    const problems = checkEnvExample('WITH_DEFAULT=x\nNO_DEFAULT=kev:0.0.11044329\n', ruleSpec);
    assert.ok(problems.some((p) => p.includes('NO_DEFAULT has no default and must be empty')));
  });

  it('requires variables with defaults to show exactly the default', () => {
    const problems = checkEnvExample('WITH_DEFAULT=y\nNO_DEFAULT=\n', ruleSpec);
    assert.ok(problems.some((p) => p.includes('WITH_DEFAULT must show its default value')));
    assert.deepEqual(checkEnvExample('WITH_DEFAULT=x\nNO_DEFAULT=\n', ruleSpec), []);
  });
});

describe('checkEnvExample', () => {
  it('passes for the committed .env.example', () => {
    assert.deepEqual(checkEnvExample(readFileSync('.env.example', 'utf8')), []);
  });

  it('reports missing, unknown and non-blank secret entries', () => {
    // Assembled at runtime so the source never contains a credential-shaped assignment.
    const text = ['A_API_KEY', 'filled-in'].join('=') + '\nUNKNOWN=1\n';
    const problems = checkEnvExample(text, spec);
    assert.ok(problems.some((p) => p.includes('A_API_KEY is secret')));
    assert.ok(problems.some((p) => p.includes('UNKNOWN is not defined')));
    assert.ok(problems.some((p) => p.startsWith('A_PUBLIC is defined')));
  });
});
