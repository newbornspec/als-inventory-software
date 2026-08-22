import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../users/user.entity';
import { Permission } from '../permissions';
import { PermissionsService } from '../permissions.service';
import { ANY_AUTHENTICATED_KEY, PERMISSIONS_KEY } from './permissions.decorator';

// Replaces RolesGuard, with the default inverted. RolesGuard returned TRUE for
// any endpoint that carried no @Roles() — which is how 44 of 122 handlers were
// reachable by every logged-in user without anyone deciding that. This guard
// fails CLOSED: an endpoint it protects must declare @RequirePermissions(...)
// or @AnyAuthenticated(), or every call is rejected. The endpoint-authz spec
// enforces the declaration at test time so the failure is a red build, not a
// production 403.
//
// Grants are read from the DATABASE via PermissionsService (30s cache), not
// from the JWT — so an admin's edit takes effect in seconds and no token
// rollout is needed. Admins bypass grant checks entirely, on their FRESH role:
// a demoted admin loses the bypass within the cache TTL even though their
// token still says 'admin' for up to 12 hours.
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true; // JwtAuthGuard has already established who they are.
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const { user } = context.switchToHttp().getRequest();
    if (!user?.userId) throw new ForbiddenException('Not authenticated.');

    if (!required || required.length === 0) {
      // Fail closed. Reaching this means a handler shipped without an access
      // declaration AND without its spec coverage — refuse rather than guess.
      throw new ForbiddenException('This endpoint declares no access rule.');
    }

    const authz = await this.permissions.getAuthz(user.userId);
    if (!authz) throw new ForbiddenException('This account no longer exists.');

    if (authz.role === UserRole.ADMIN) return true;
    if (required.some((p) => authz.permissions.includes(p))) return true;

    throw new ForbiddenException("You don't have permission to do this.");
  }
}
