import { pgTestDatabaseName } from './pg-test-db-for-spec';

// The Postgres specs switch the certificate trigger off, delete certificates
// and leave rows signed with a throwaway key: they must never reach the app's
// own database (review of plan step 29 - running them on the dev database
// made every certificate the app issued afterwards fail its public check).
describe('the Postgres specs run on a dedicated test database only', () => {
  it('defaults to als_inventory_test, not the app database', () => {
    expect(pgTestDatabaseName({})).toBe('als_inventory_test');
    expect(pgTestDatabaseName({ ALS_PG_TEST_DB: ' ' })).toBe(
      'als_inventory_test',
    );
  });

  it('accepts another name only when it ends in _test', () => {
    expect(pgTestDatabaseName({ ALS_PG_TEST_DB: 'ci_certs_test' })).toBe(
      'ci_certs_test',
    );
  });

  it.each([
    'als_inventory',
    'postgres',
    'als_test_prod',
    'x_test; DROP',
    'A_TEST',
  ])('refuses %p', (name) => {
    expect(() => pgTestDatabaseName({ ALS_PG_TEST_DB: name })).toThrow(
      /dedicated test database/,
    );
  });
});
