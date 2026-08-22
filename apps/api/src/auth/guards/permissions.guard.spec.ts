import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { ANY_AUTHENTICATED_KEY, PERMISSIONS_KEY } from './permissions.decorator';
import { UserRole } from '../../users/user.entity';
import type { AuthzSnapshot } from '../permissions.service';

// The authorization rewrite shipped with zero role/permission test coverage
// anywhere in the API — this spec is the regression net for the guard's five
// load-bearing behaviours: fail-closed, OR semantics, admin bypass on the
// FRESH role (not the token's), AnyAuthenticated opt-out, and deleted-user
// rejection.

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
};

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
      { role: UserRole.ADMIN, permissions: [] },
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

  it('lets @AnyAuthenticated() through without touching the database', async () => {
    const { guard, getAuthz } = makeGuard({ [ANY_AUTHENTICATED_KEY]: true }, null);
    await expect(guard.canActivate(makeContext({ userId: 'u1' }))).resolves.toBe(true);
    expect(getAuthz).not.toHaveBeenCalled();
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
