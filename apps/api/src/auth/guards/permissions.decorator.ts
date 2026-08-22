import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permissions';

export const PERMISSIONS_KEY = 'permissions';
export const ANY_AUTHENTICATED_KEY = 'any_authenticated';

// Grants access when the user holds ANY of the listed permissions (OR).
// OR is deliberate: shared endpoints serve several flows — the asset list is
// read by the Assets register, the Goods In accordion and the Scan page — and
// a user needs whichever module brought them there, not all of them.
export const RequirePermissions = (...permissions: [Permission, ...Permission[]]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

// Explicit opt-out: any authenticated user, no permission needed. Reserved for
// reference data every form reads (locations, lookups) and channels with their
// own row-level checks (the PowerSync upload). PermissionsGuard fails CLOSED,
// so an endpoint carrying neither decorator is denied — being open is always a
// visible, greppable decision, never a forgotten default. That default is what
// left 44 endpoints unguarded under the old RolesGuard.
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED_KEY, true);
