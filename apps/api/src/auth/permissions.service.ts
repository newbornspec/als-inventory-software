import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/user.entity';

export interface AuthzSnapshot {
  role: UserRole;
  permissions: string[];
}

// How long a permissions lookup may be served from memory. The trade-off this
// buys: the guard reads the DATABASE, not the JWT, so revoking a permission
// takes effect within this window instead of the token's 12-hour lifetime —
// while the per-request cost stays one cache hit, not one query per call.
// (The JWT payload is deliberately untouched: PowerSync validates the same
// token by aud/kid, and changing its shape would be a rollout hazard.)
export const AUTHZ_CACHE_TTL_MS = 30_000;

@Injectable()
export class PermissionsService {
  private cache = new Map<string, { snapshot: AuthzSnapshot; expiresAt: number }>();

  constructor(@InjectRepository(User) private users: Repository<User>) {}

  // null = the user no longer exists (deleted since the token was issued).
  async getAuthz(userId: string): Promise<AuthzSnapshot | null> {
    const hit = this.cache.get(userId);
    if (hit && hit.expiresAt > Date.now()) return hit.snapshot;

    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true, permissions: true },
    });
    if (!user) {
      this.cache.delete(userId);
      return null;
    }
    const snapshot: AuthzSnapshot = { role: user.role, permissions: user.permissions ?? [] };
    this.cache.set(userId, { snapshot, expiresAt: Date.now() + AUTHZ_CACHE_TTL_MS });
    return snapshot;
  }

  // Called by UsersService on update/delete so an admin's edit lands on the
  // next request instead of after the TTL. Only helps this process — other
  // instances converge within the TTL, which is the accepted staleness bound.
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
