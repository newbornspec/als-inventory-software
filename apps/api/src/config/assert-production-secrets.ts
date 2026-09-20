// Fail-closed check for the secrets that must never fall back to their
// development defaults in production.
//
// configuration.ts gives JWT_SECRET a committed default ('dev-secret-change-me')
// so the app runs out of the box on a developer machine. That default is public
// in this repository: an access token signed with it can be forged by anyone,
// and — because tokens are signed, not stored — a forged admin token is
// indistinguishable from a real one and cannot be revoked. If the Railway
// variable were ever dropped or renamed during a service move, the API would
// keep serving happily on that public secret with nothing in the logs to say so.
//
// The certificate signing key already refuses to start when it is set but
// unusable (certificate-signing.ts), on exactly this reasoning: a failed deploy
// is safer than one that looks secure and is not. This applies the same rule to
// the session secret — but keyed on NODE_ENV=production, because the whole point
// of the default is that development and CI (which never set it) keep working.

export const DEV_JWT_SECRET = 'dev-secret-change-me';

export interface SecretEnv {
  NODE_ENV?: string;
  JWT_SECRET?: string;
}

// Returns the list of problems found (empty when all is well) so this is unit
// testable without a process. main.ts turns a non-empty list into a refusal.
export function productionSecretProblems(env: SecretEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  const jwt = env.JWT_SECRET;
  if (!jwt || jwt.trim() === '') {
    problems.push('JWT_SECRET is not set');
  } else if (jwt === DEV_JWT_SECRET) {
    problems.push(
      'JWT_SECRET is still the public development default — set a real secret',
    );
  }
  return problems;
}

// Throws in production if any secret is missing or left at its dev default.
export function assertProductionSecrets(env: SecretEnv = process.env): void {
  const problems = productionSecretProblems(env);
  if (problems.length) {
    throw new Error(
      `Refusing to start in production: ${problems.join('; ')}. ` +
        'These would let anyone forge session tokens. Set them in the ' +
        'deployment environment and redeploy.',
    );
  }
}
