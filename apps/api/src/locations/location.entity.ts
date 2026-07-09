import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('locations')
export class Location {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', nullable: true })
  address: string | null;

  // The technician primarily assigned to this location — used by PowerSync
  // sync rules to scope which assets a scanning device downloads offline.
  @Column({ name: 'assigned_user_id', type: 'uuid', nullable: true })
  assignedUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_user_id' })
  assignedUser: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
