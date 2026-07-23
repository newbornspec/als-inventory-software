import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityLog } from './activity-log.entity';
import { isScopedManager, type RequestUser } from '../common/ownership';

export interface RecordInput {
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
}

export interface ActivityView {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  createdAt: Date;
  user: { id: string; name: string } | null;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectRepository(ActivityLog) private readonly repo: Repository<ActivityLog>,
  ) {}

  // Fire-and-forget: logging must never break the operation it records. Any
  // failure is swallowed (and logged to the server console) rather than thrown.
  async record(input: RecordInput): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          userId: input.userId ?? null,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          summary: input.summary,
        }),
      );
    } catch (err) {
      this.logger.warn(`Failed to record activity "${input.action}": ${String(err)}`);
    }
  }

  async list(limit = 100, user?: RequestUser): Promise<ActivityView[]> {
    // Managers see only their own actions; admins/technicians see everything.
    const rows = await this.repo.find({
      where: isScopedManager(user) ? { userId: user!.userId } : {},
      relations: ['user'],
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      createdAt: r.createdAt,
      user: r.user ? { id: r.user.id, name: r.user.name } : null,
    }));
  }
}
