import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  ADMIN = 'admin',
  MANAGER = 'manager',
  TECHNICIAN = 'technician',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  // Two jobs remain for role now that per-user permissions exist: 'admin' is
  // the guard's master bypass, and 'manager' still drives lot ownership
  // scoping (common/ownership.ts) — a separate axis from permissions.
  @Column({ type: 'enum', enum: UserRole, default: UserRole.TECHNICIAN })
  role: UserRole;

  // Per-user grants from the catalog in auth/permissions.ts. text[] rather
  // than a pg enum so a new permission never needs a schema migration. Typed
  // string[] (not Permission[]) deliberately: rows may briefly hold slugs a
  // newer/older code version doesn't know, and the guard just won't match them.
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  permissions: string[];

  // The lot this user is currently auditing devices into (set from the web,
  // read by the capture tool). No ORM relation — resolved by id where needed.
  @Column({ name: 'active_audit_lot_id', type: 'uuid', nullable: true })
  activeAuditLotId: string | null;

  // NULL = enabled. A timestamp rather than a boolean because this app records
  // every human state change as when-and-by-whom (assets.sold_at/sold_by_id,
  // moved_to_pallet_at/by_id), and "was this audit filed before or after they
  // left?" is a question an ITAD client can reasonably ask.
  //
  // Disabling is the alternative to deleting: deletion SET NULLs the user off
  // every audit, wipe and sale they touched, destroying the trail. The account
  // stays, the access stops. Enforced in PermissionsGuard and AuthService —
  // NOT in the JWT, which cannot be revoked (see auth/strategies/jwt.strategy.ts).
  @Column({ name: 'disabled_at', type: 'timestamp', nullable: true })
  disabledAt: Date | null;

  @Column({ name: 'disabled_by_id', type: 'uuid', nullable: true })
  disabledById: string | null;

  // Set whenever the password changes. Any access token issued BEFORE this is
  // treated as stale and rejected, which is what makes an admin's password
  // reset actually end the old sessions — tokens themselves cannot be revoked
  // and live 12h. NULL = never reset, so no existing token is affected.
  @Column({ name: 'password_changed_at', type: 'timestamp', nullable: true })
  passwordChangedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
