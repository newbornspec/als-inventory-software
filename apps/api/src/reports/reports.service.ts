import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetAuditStatus, AssetStockStatus } from '../assets/asset.entity';

export interface Notification {
  id: string;
  type: 'warranty_expired' | 'warranty_expiring' | 'quarantined' | 'repair_required' | 'ber';
  severity: 'critical' | 'warning';
  assetId: string;
  assetTag: string;
  assetName: string;
  message: string;
}

const WARRANTY_LOOKAHEAD_DAYS = 30;

@Injectable()
export class ReportsService {
  constructor(@InjectRepository(Asset) private assets: Repository<Asset>) {}

  async getNotifications(): Promise<Notification[]> {
    const assets = await this.assets.find({ relations: ['location'] });
    const now = new Date();
    const lookahead = new Date(now.getTime() + WARRANTY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const notifications: Notification[] = [];

    for (const asset of assets) {
      if (asset.stockStatus === AssetStockStatus.QUARANTINED) {
        notifications.push({
          id: `${asset.id}:quarantined`,
          type: 'quarantined',
          severity: 'warning',
          assetId: asset.id,
          assetTag: asset.tag,
          assetName: asset.name,
          message: `${asset.name} (${asset.tag}) is quarantined/on hold`,
        });
      }

      if (asset.auditStatus === AssetAuditStatus.REPAIR_REQUIRED) {
        notifications.push({
          id: `${asset.id}:repair_required`,
          type: 'repair_required',
          severity: 'warning',
          assetId: asset.id,
          assetTag: asset.tag,
          assetName: asset.name,
          message: `${asset.name} (${asset.tag}) needs repair`,
        });
      }

      if (asset.auditStatus === AssetAuditStatus.BEYOND_ECONOMIC_REPAIR) {
        notifications.push({
          id: `${asset.id}:ber`,
          type: 'ber',
          severity: 'critical',
          assetId: asset.id,
          assetTag: asset.tag,
          assetName: asset.name,
          message: `${asset.name} (${asset.tag}) is beyond economic repair`,
        });
      }

      if (asset.warrantyExpiresAt) {
        const expiresAt = new Date(asset.warrantyExpiresAt);
        if (expiresAt < now) {
          notifications.push({
            id: `${asset.id}:warranty_expired`,
            type: 'warranty_expired',
            severity: 'critical',
            assetId: asset.id,
            assetTag: asset.tag,
            assetName: asset.name,
            message: `${asset.name} (${asset.tag}) warranty expired on ${asset.warrantyExpiresAt}`,
          });
        } else if (expiresAt <= lookahead) {
          notifications.push({
            id: `${asset.id}:warranty_expiring`,
            type: 'warranty_expiring',
            severity: 'warning',
            assetId: asset.id,
            assetTag: asset.tag,
            assetName: asset.name,
            message: `${asset.name} (${asset.tag}) warranty expires on ${asset.warrantyExpiresAt}`,
          });
        }
      }
    }

    return notifications;
  }

  async exportAssetsCsv(): Promise<string> {
    const assets = await this.assets.find({ relations: ['location', 'owner'] });

    const header = [
      'tag',
      'name',
      'category',
      'stock_status',
      'condition_grade',
      'audit_status',
      'location',
      'owner',
      'warranty_expires_at',
      'updated_at',
    ];
    const rows = assets.map((a) =>
      [
        a.tag,
        a.name,
        a.category,
        a.stockStatus,
        a.conditionGrade ?? '',
        a.auditStatus ?? '',
        a.location?.name ?? '',
        a.owner?.name ?? '',
        a.warrantyExpiresAt ?? '',
        a.updatedAt.toISOString(),
      ]
        .map(csvEscape)
        .join(','),
    );

    return [header.join(','), ...rows].join('\n');
  }
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
