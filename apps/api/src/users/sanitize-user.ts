import { User } from './user.entity';

export type SafeUser = Omit<User, 'passwordHash'>;

// Strips passwordHash before a User (or a relation containing one) crosses
// the API boundary. Any endpoint that returns a User directly or via a
// relation (e.g. Batch.receivedBy, AssetAudit.auditedBy) must run it through
// here — TypeORM has no concept of "never serialize this column."
export function sanitizeUser(user: User): SafeUser {
  const { passwordHash, ...safe } = user;
  void passwordHash;
  return safe;
}
