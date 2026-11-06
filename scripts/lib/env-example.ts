/**
 * Consistency rules between `.env.example` and the env specification.
 */
import {
  ENV_SPEC,
  PUBLIC_PREFIX,
  parseDotenv,
  type EnvVarSpec,
} from '../../packages/core/src/index.ts';

const SECRET_NAME =
  /(PRIVATE_KEY|SECRET|API_KEY|MANAGEMENT_KEY|TOKEN|PASSWORD|ACCESS_CODE|RPC_URL)/;

/** Problems in the spec itself: secrets must never be bundled into the browser. */
export function checkSpec(spec: readonly EnvVarSpec[] = ENV_SPEC): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const v of spec) {
    if (names.has(v.name)) problems.push(`${v.name}: defined twice in ENV_SPEC`);
    names.add(v.name);

    const isPublic = v.name.startsWith(PUBLIC_PREFIX);
    if (isPublic && v.secret) {
      problems.push(`${v.name}: secret variables must not use the public ${PUBLIC_PREFIX} prefix`);
    }
    if (isPublic && SECRET_NAME.test(v.name)) {
      problems.push(
        `${v.name}: name looks like a credential but would be bundled into the browser`,
      );
    }
    if (!isPublic && v.group === 'web') {
      problems.push(`${v.name}: web group variables must use the ${PUBLIC_PREFIX} prefix`);
    }
    if (SECRET_NAME.test(v.name) && !v.secret) {
      problems.push(`${v.name}: credential-like name must be marked secret`);
    }
    if (v.secret && v.default !== undefined) {
      problems.push(`${v.name}: secret variables must not have a default value`);
    }
    if (v.default !== undefined && v.validate !== undefined) {
      const reason = v.validate(v.default);
      if (reason !== null) problems.push(`${v.name}: default value ${reason}`);
    }
  }
  return problems;
}

/** Problems in the .env.example text relative to the spec. */
export function checkEnvExample(text: string, spec: readonly EnvVarSpec[] = ENV_SPEC): string[] {
  const { entries, errors } = parseDotenv(text);
  const problems = [...errors];
  const byName = new Map(spec.map((v) => [v.name, v]));
  const present = new Set<string>();

  for (const entry of entries) {
    present.add(entry.key);
    const v = byName.get(entry.key);
    if (v === undefined) {
      problems.push(`line ${entry.line}: ${entry.key} is not defined in ENV_SPEC`);
      continue;
    }
    if (v.secret && entry.value !== '') {
      problems.push(`line ${entry.line}: ${entry.key} is secret and must be empty in .env.example`);
      continue;
    }
    // The template documents defaults only. Anything user-specific (no default)
    // stays blank, so a real account ID, name or URL can never be committed here.
    if (v.default === undefined && entry.value !== '') {
      problems.push(
        `line ${entry.line}: ${entry.key} has no default and must be empty in .env.example`,
      );
      continue;
    }
    if (v.default !== undefined && entry.value !== v.default) {
      problems.push(`line ${entry.line}: ${entry.key} must show its default value in .env.example`);
    }
  }

  for (const v of spec) {
    if (!present.has(v.name))
      problems.push(`${v.name} is defined in ENV_SPEC but missing from .env.example`);
  }
  return problems;
}
