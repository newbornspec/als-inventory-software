import type { WipeAttestation, WipeSource } from './manual-wipe';

// Who the certificate names, and as what (remediation spec C-1).
//
// The station signs in as ONE shared account, so the account on a station
// record is not the person who wiped the drive - yet the certificate printed
// it as "Performed by", naming e.g. the admin account for every wipe ever
// done. The name the operator typed at the station (operator_name) was never
// printed at all. Now:
//   - the typed name prints as "Operator (self-declared)": nothing verifies
//     it, and the label says so;
//   - the account prints as what it is, "Filed by account";
//   - an older station record with no typed name prints only the account,
//     still labelled as the account, never as the performer;
//   - ...unless an admin has flagged that account as a shared station login
//     (users.is_station, plan step 28 stage 1): then the certificate says
//     outright that nobody was recorded - "Operator: not recorded (shared
//     station account)" - instead of leaving a reader to take the account
//     name for the person.
// Stage 1 only labels; it never refuses a certificate (owner decision D28,
// owner-reversible: stage 2 would refuse these once every stick in the field
// sends an operator). Names only - no job title or contact details.
// A manual record keeps "Recorded by" (manual-wipe.ts): there the account is
// a personal web login, and the person behind it did record the wipe.
export const OPERATOR_NOT_RECORDED = 'not recorded (shared station account)';

export function erasurePeople(
  source: WipeSource,
  att: WipeAttestation,
  operatorName: string | null | undefined,
  accountName: string | null | undefined,
  // The filing account is flagged as a shared station login.
  stationAccount = false,
): [string, string][] {
  const operator = operatorName?.trim();
  const account = accountName?.trim() || '—';
  const rows: [string, string][] = [];
  if (operator) rows.push(['Operator (self-declared)', operator]);
  else if (source === 'station' && stationAccount)
    rows.push(['Operator', OPERATOR_NOT_RECORDED]);
  rows.push([
    source === 'manual' ? att.performerLabel : 'Filed by account',
    account,
  ]);
  return rows;
}
