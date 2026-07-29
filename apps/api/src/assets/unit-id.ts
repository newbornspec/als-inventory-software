import { Repository } from 'typeorm';
import { Asset } from './asset.entity';

// The permanent Unit ID — third level of Batch -> Lot -> Unit.
//
// Drawn from a Postgres sequence rather than counting rows, so numbers are
// never reused and two devices audited at the same moment on two stations can
// never collide. Shared by both creation paths (manual entry and the USB audit
// tool) so a device gets the same style of ID however it enters the system.
export async function nextUnitId(assets: Repository<Asset>): Promise<string> {
  const rows = await assets.query(`SELECT nextval('unit_number_seq') AS n`);
  return `U-${String(rows[0].n).padStart(6, '0')}`;
}
