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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
