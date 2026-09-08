import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { ANY_AUTHENTICATED_KEY, PERMISSIONS_KEY } from './permissions.decorator';
import { UserRole } from '../../users/user.entity';
import type { AuthzSnapshot } from '../permissions.service';

// The authorization rewrite shipped with zero role/permission test coverage
// anywhere in the API — this spec is the regression net for the guard's five
// load-bearing behaviours: fail-closed, OR semantics, admin bypass on the
// FRESH role (not the token's), AnyAuthenticated opt-out, deleted-user
// rejection, and disabled-account rejection.

type MetadataTable = Partial<Record<string, unknown>>;

function makeGuard(metadata: MetadataTable, snapshot: AuthzSnapshot | null) {
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  const getAuthz = jest.fn().mockResolvedValue(snapshot);
  const guard = new PermissionsGuard(reflector, { getAuthz } as never);
  return { guard, getAuthz };
}

function makeContext(user: { userId: string; role?: string } | null) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

const TECH: AuthzSnapshot = {
  role: UserRole.TECHNICIAN,
  permissions: ['goods_in', 'perform_goods_in_audit'],
  disabled: false,
};

const DISABLED_TECH: AuthzSnapshot = { ...TECH, disabled: true };

describe('PermissionsGuard', () => {
  it('fails CLOSED: an endpoint with no declaration is denied, not allowed', async () => {
    // This is the inversion of RolesGuard, whose no-metadata default of true
    // is how 44 endpoints shipped open. If this test starts failing, that
    // hole has been reopened.
    const { guard } = makeGuard({}, TECH);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('grants when the user holds ANY listed permission (OR semantics)', async () => {
    const { guard } = makeGuard({ [PERMISSIONS_KEY]: ['assets', 'goods_in'] }, TECH);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).resolves.toBe(true);
  });

  it('denies when the user holds none of the listed permissions', async () => {
    const { guard } = makeGuard({ [PERMISSIONS_KEY]: ['reports', 'sold'] }, TECH);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('bypasses grant checks for an admin — on the FRESH role from the DB', async () => {
    // Empty grants on purpose: the bypass must not depend on the permissions
    // array, or a bad grant edit could lock out the account that fixes grants.
    const { guard } = makeGuard(
      { [PERMISSIONS_KEY]: ['users'] },
      { role: UserRole.ADMIN, permissions: [], disabled: false },
    );
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).resolves.toBe(true);
  });

  it('ignores the token role: a demoted admin is judged by the DB snapshot', async () => {
    // The request claims role 'admin' (token minted before the demotion); the
    // DB says technician. The DB must win.
    const { guard } = makeGuard({ [PERMISSIONS_KEY]: ['users'] }, TECH);
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', role: 'admin' })),
    ).rejects.toThrow(ForbiddenException);
  });

  // CONTRACT CHANGE, deliberate. This used to assert that @AnyAuthenticated()
  // returned true WITHOUT touching the database. That held while the only
  // question was "which permission?", but a disabled account must be shut out
  // of every authenticated endpoint — and @AnyAuthenticated() covers
  // POST /powersync/upload, the offline write channel. Skipping the lookup
  // there let a disabled technician's phone keep pushing queued audits into
  // Postgres. The lookup is cached (30s TTL), so the cost is a cache hit.
  it('lets @AnyAuthenticated() through, but still checks the account is usable', async () => {
    const { guard, getAuthz } = makeGuard({ [ANY_AUTHENTICATED_KEY]: true }, TECH);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).resolves.toBe(true);
    expect(getAuthz).toHaveBeenCalledWith('u1');
  });

  it('rejects a DISABLED account on an @AnyAuthenticated() endpoint', async () => {
    // The powersync-upload case: identity valid, token unexpired, account
    // switched off. This is what stops a departed technician's phone still
    // writing into the database.
    const { guard } = makeGuard({ [ANY_AUTHENTICATED_KEY]: true }, DISABLED_TECH);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a DISABLED account that holds the required permission', async () => {
    const { guard } = makeGuard({ [PERMISSIONS_KEY]: ['goods_in'] }, DISABLED_TECH);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a DISABLED admin — the bypass must not outrank being switched off', async () => {
    const { guard } = makeGuard(
      { [PERMISSIONS_KEY]: ['users'] },
      { role: UserRole.ADMIN, permissions: [], disabled: true },
    );
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a valid token whose user has since been deleted', async () => {
    const { guard } = makeGuard({ [PERMISSIONS_KEY]: ['goods_in'] }, null);
    await expect(guard.canActivate(makeContext({ userId: 'gone' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects an unauthenticated request outright', async () => {
    const { guard } = makeGuard({ [PERMISSIONS_KEY]: ['goods_in'] }, TECH);
    await expect(guard.canActivate(makeContext(null))).rejects.toThrow(ForbiddenException);
  });
});
