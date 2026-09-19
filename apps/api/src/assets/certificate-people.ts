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
//     still labelled as the account, never as the performer.
// A manual record keeps "Recorded by" (manual-wipe.ts): there the account is
// a personal web login, and the person behind it did record the wipe.
export function erasurePeople(
  source: WipeSource,
  att: WipeAttestation,
  operatorName: string | null | undefined,
  accountName: string | null | undefined,
): [string, string][] {
  const operator = operatorName?.trim();
  const account = accountName?.trim() || '—';
  const rows: [string, string][] = [];
  if (operator) rows.push(['Operator (self-declared)', operator]);
  rows.push([
    source === 'manual' ? att.performerLabel : 'Filed by account',
    account,
  ]);
  return rows;
}
