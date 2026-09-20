import {
  assertProductionSecrets,
  productionSecretProblems,
  DEV_JWT_SECRET,
} from './assert-production-secrets';

describe('production secret guard', () => {
  it('lets development and CI through with no secret set', () => {
    expect(productionSecretProblems({})).toEqual([]);
    expect(productionSecretProblems({ NODE_ENV: 'test' })).toEqual([]);
    expect(
      productionSecretProblems({ NODE_ENV: 'development', JWT_SECRET: DEV_JWT_SECRET }),
    ).toEqual([]);
  });

  it('refuses production when JWT_SECRET is missing', () => {
    expect(productionSecretProblems({ NODE_ENV: 'production' })).toEqual([
      'JWT_SECRET is not set',
    ]);
    expect(
      productionSecretProblems({ NODE_ENV: 'production', JWT_SECRET: '   ' }),
    ).toEqual(['JWT_SECRET is not set']);
  });

  it('refuses production when JWT_SECRET is still the committed dev default', () => {
    const problems = productionSecretProblems({
      NODE_ENV: 'production',
      JWT_SECRET: DEV_JWT_SECRET,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/public development default/);
  });

  it('accepts production with a real secret', () => {
    expect(
      productionSecretProblems({
        NODE_ENV: 'production',
        JWT_SECRET: 'a-genuinely-random-64-char-secret-from-the-deploy-env',
      }),
    ).toEqual([]);
  });

  it('assertProductionSecrets throws only when there is a problem', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'production', JWT_SECRET: 'real' })).not.toThrow();
    expect(() => assertProductionSecrets({})).not.toThrow();
    expect(() =>
      assertProductionSecrets({ NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET }),
    ).toThrow(/Refusing to start in production/);
  });
});
