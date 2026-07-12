import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { User } from '../users/user.entity';

// A device photo (before/after refurb, damage, labels). Bytes live in Postgres.
// `data` is select:false so list queries never drag the image blobs back — it's
// only loaded when streaming a single photo.
@Entity('asset_photos')
export class AssetPhoto {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @ManyToOne(() => Asset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset: Asset;

  @Column({ type: 'bytea', select: false })
  data: Buffer;

  @Column({ name: 'content_type', type: 'varchar' })
  contentType: string;

  @Column({ type: 'varchar', nullable: true })
  caption: string | null;

  @Column({ name: 'uploaded_by_id', type: 'uuid', nullable: true })
  uploadedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'uploaded_by_id' })
  uploadedBy: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
