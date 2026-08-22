import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
// Nest's internal metadata keys. Internal but stable across every 10.x/11.x
// release; if they ever move, this spec fails loudly rather than passing vacuously
// (the controller-count floor below catches a silent discovery breakdown too).
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ANY_AUTHENTICATED_KEY, PERMISSIONS_KEY } from './guards/permissions.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import { ALL_PERMISSIONS } from './permissions';

// The fleet-wide access net. Every HTTP handler in the API must carry an
// explicit access declaration — @RequirePermissions(...) or @AnyAuthenticated()
// on the method or its class — and every controller using them must actually
// attach PermissionsGuard, or the metadata is decoration that enforces nothing.
//
// This exists because the previous regime failed silently in exactly this
// shape: RolesGuard defaulted OPEN, so 44 of 122 handlers were reachable by
// any logged-in user without anyone ever deciding that. A new endpoint added
// without a declaration turns this suite red instead of shipping open (the
// guard would also 403 it at runtime — this catches it before deploy).

// The only deliberately public/unguarded surfaces. Adding a class here is a
// reviewed decision, which is the point.
const PUBLIC_CONTROLLERS = new Set([
  'AppController', // health probe
  'AuthController', // login/refresh are public by nature; me/logout are marked
]);

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface RouteInfo {
  controller: string;
  method: string;
  declared: boolean;
}

function collectControllers() {
  const srcRoot = path.resolve(__dirname, '..');
  const controllers: { name: string; cls: any }[] = [];
  for (const file of findControllerFiles(srcRoot)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported === 'function' && Reflect.getMetadata(PATH_METADATA, exported) !== undefined) {
        controllers.push({ name: exported.name, cls: exported });
      }
    }
  }
  return controllers;
}

function collectRoutes(cls: any): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const classDeclared =
    Reflect.getMetadata(PERMISSIONS_KEY, cls) !== undefined ||
    Reflect.getMetadata(ANY_AUTHENTICATED_KEY, cls) !== undefined;
  for (const prop of Object.getOwnPropertyNames(cls.prototype)) {
    if (prop === 'constructor') continue;
    const handler = cls.prototype[prop];
    if (typeof handler !== 'function') continue;
    if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue; // not a route
    const declared =
      classDeclared ||
      Reflect.getMetadata(PERMISSIONS_KEY, handler) !== undefined ||
      Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler) !== undefined;
    routes.push({ controller: cls.name, method: prop, declared });
  }
  return routes;
}

describe('endpoint authorization coverage', () => {
  const controllers = collectControllers();

  it('discovered the whole controller fleet (floor guards against silent breakage)', () => {
    // 21 at the time of writing. A count below the floor means discovery broke
    // and every other assertion here is passing vacuously.
    expect(controllers.length).toBeGreaterThanOrEqual(21);
  });

  it('every route on every non-public controller declares its access', () => {
    const undeclared: string[] = [];
    for (const { name, cls } of controllers) {
      if (PUBLIC_CONTROLLERS.has(name)) continue;
      for (const route of collectRoutes(cls)) {
        if (!route.declared) undeclared.push(`${route.controller}.${route.method}`);
      }
    }
    // Failing entries each need @RequirePermissions(...) or @AnyAuthenticated().
    expect(undeclared).toEqual([]);
  });

  it('every non-public controller actually attaches PermissionsGuard', () => {
    // Metadata without the guard enforces nothing — the decorators are read
    // only by PermissionsGuard.
    const missing: string[] = [];
    for (const { name, cls } of controllers) {
      if (PUBLIC_CONTROLLERS.has(name)) continue;
      const guards: any[] = Reflect.getMetadata(GUARDS_METADATA, cls) ?? [];
      if (!guards.includes(PermissionsGuard)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('no controller still references the retired RolesGuard', () => {
    const stale: string[] = [];
    for (const { name, cls } of controllers) {
      const guards: any[] = Reflect.getMetadata(GUARDS_METADATA, cls) ?? [];
      if (guards.some((g) => g?.name === 'RolesGuard')) stale.push(name);
    }
    expect(stale).toEqual([]);
  });

  it('every declared permission slug exists in the catalog', () => {
    // A typo'd slug in a decorator would otherwise deny everyone forever with
    // no error anywhere — the guard just never matches it.
    const bad: string[] = [];
    const catalog = new Set<string>(ALL_PERMISSIONS);
    for (const { name, cls } of controllers) {
      const spots: [string, unknown][] = [[`${name} (class)`, Reflect.getMetadata(PERMISSIONS_KEY, cls)]];
      for (const prop of Object.getOwnPropertyNames(cls.prototype)) {
        if (prop === 'constructor') continue;
        const handler = cls.prototype[prop];
        if (typeof handler !== 'function') continue;
        spots.push([`${name}.${prop}`, Reflect.getMetadata(PERMISSIONS_KEY, handler)]);
      }
      for (const [where, perms] of spots) {
        if (!Array.isArray(perms)) continue;
        for (const p of perms) if (!catalog.has(p)) bad.push(`${where}: '${p}'`);
      }
    }
    expect(bad).toEqual([]);
  });
});
