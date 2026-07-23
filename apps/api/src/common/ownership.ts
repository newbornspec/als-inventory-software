import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../users/user.entity';

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

// A TypeORM `where` fragment that restricts batches to the caller's own, but
// only for scoped managers; empty (= no restriction) for admins/technicians.
export function ownerWhere(user?: RequestUser | null): { ownerId?: string } {
  return isScopedManager(user) ? { ownerId: user!.userId } : {};
}

// Throw 403 if a scoped manager is touching a batch they don't own. No-op for
// admins/technicians, or when no user context is supplied (internal calls).
export function assertOwnsBatch(ownerId: string | null, user?: RequestUser | null): void {
  if (isScopedManager(user) && ownerId !== user!.userId) {
    throw new ForbiddenException('You do not have access to this lot.');
  }
}
