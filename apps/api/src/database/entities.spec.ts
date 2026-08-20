import * as fs from 'fs';
import * as path from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { ALL_ENTITIES } from './entities';

// An entity missing from ALL_ENTITIES does not fail the build, does not fail
// startup, and does not fail dependency injection — TypeORM only resolves
// metadata on the first query, so the app boots healthy and one endpoint 500s
// with EntityMetadataNotFoundError. That is exactly how PalletMerge reached
// production and took the pallet detail page down while the list kept working.
//
// This test walks the *.entity.ts files on disk instead of trusting a list, so
// the next entity someone adds cannot repeat it.
function entityFiles(dir: string, found: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) entityFiles(full, found);
    else if (name.endsWith('.entity.ts')) found.push(full);
  }
  return found;
}

describe('ALL_ENTITIES', () => {
  const srcRoot = path.join(__dirname, '..');

  it('contains every @Entity class in the codebase', () => {
    const files = entityFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    // Importing each file registers its @Entity classes in TypeORM's metadata
    // storage, which is the authority on what is an entity — no name-matching
    // or path conventions to get wrong.
    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(file);
    }

    const declared = new Set<unknown>(ALL_ENTITIES);
    const missing = getMetadataArgsStorage()
      .tables.map((t) => t.target)
      .filter((target) => typeof target === 'function')
      .filter((target) => !declared.has(target))
      .map((target) => (target as { name: string }).name);

    expect([...new Set(missing)]).toEqual([]);
  });

  it('lists nothing twice', () => {
    const names = ALL_ENTITIES.map((e) => e.name);
    expect(names).toEqual([...new Set(names)]);
  });
});
