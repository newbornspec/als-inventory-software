import { ForbiddenException } from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { UserRole } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';

// The shape of req.user set by JwtStrategy.validate().
export interface RequestUser {
  userId: string;
  role: UserRole | string;
  email?: string;
}

// Per-user isolation applies to MANAGERS ONLY. Admins and technicians see
// everything (technicians are floor staff who scan/audit into any lot). This is
// the single source of truth for "is this caller scoped?" across the app.
export function isScopedManager(user?: RequestUser | null): boolean {
  return user?.role === UserRole.MANAGER;
}

// What a scoped manager may see/act on: lots they OWN, plus UNOWNED "pool" lots
// (owner_id IS NULL — e.g. created by a technician). Admins/technicians: no
// restriction. Returned as a TypeORM `where` for list queries (array = OR).
export function accessibleBatchWhere(user?: RequestUser | null) {
  return isScopedManager(user)
    ? [{ ownerId: user!.userId }, { ownerId: IsNull() }]
    : {};
}

// Same rule as a query-builder condition for a joined batch alias. Binds
// `:ownerUid` — callers pass `{ ownerUid: user.userId }`.
export function managerBatchCondition(alias: string): string {
  return `(${alias}.ownerId = :ownerUid OR ${alias}.ownerId IS NULL)`;
}

// Whether a scoped manager may act on a specific batch (their own, or a pool
// lot). Callers gate on isScopedManager() first; this just runs the check.
export async function managerCanAccessBatch(
  batches: Repository<Batch>,
  batchId: string | null | undefined,
  user: RequestUser,
): Promise<boolean> {
  if (batchId == null) return false;
  const n = await batches.count({
    where: [
      { id: batchId, ownerId: user.userId },
      { id: batchId, ownerId: IsNull() },
    ],
  });
  return n > 0;
}

// Throw 403 if a scoped manager touches a lot that is neither theirs nor a pool
// lot. No-op for admins/technicians or when no user context is supplied.
export function assertOwnsBatch(ownerId: string | null, user?: RequestUser | null): void {
  if (!isScopedManager(user)) return;
  if (ownerId !== user!.userId && ownerId != null) {
    throw new ForbiddenException('You do not have access to this lot.');
  }
}
