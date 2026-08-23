import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetAudit } from '../assets/asset-audit.entity';
import { isScopedManager, type RequestUser } from '../common/ownership';

// The cross-asset audit feed behind the Audit workspace. asset_audits is one
// row per audit EVENT, and the field tools deliberately file several events
// for one machine in one session — the capture posts a row, then each wiped
// drive posts another. So the feed counts and groups by DEVICE, and shows the
// events underneath: "12 devices · 29 events" is honest where a naive row
// count would report a day's work double.
//
// Days are London days. created_at is a timestamp-without-timezone holding
// UTC (the server's clock), so the cast marks it as UTC first, THEN converts
// — `created_at AT TIME ZONE 'Europe/London'` alone would run the conversion
// backwards and shift every late-evening audit into the wrong day.
const LONDON_DAY = `((aa."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date`;

// Feed filter: a stored kind, or 'unclassified' for rows that predate the
// audit_kind column (or came from a stick that does). Anything else is a 400.
export const AUDIT_KIND_FILTERS = ['amazon', 'goods_in', 'unclassified'] as const;
export type AuditKindFilter = (typeof AUDIT_KIND_FILTERS)[number];

function kindClause(kind: AuditKindFilter | undefined, params: unknown[]): string {
  if (!kind) return '';
  if (kind === 'unclassified') return `AND aa."audit_kind" IS NULL`;
  params.push(kind);
  return `AND aa."audit_kind" = $${params.length}`;
}

export interface AuditDaySummary {
  day: string; // YYYY-MM-DD
  devices: number;
  events: number;
}

export interface DayEventRow {
  id: string;
  asset_id: string;
  created_at: string;
  audit_status: string | null;
  cosmetic_grade: string | null;
  data_wipe_status: string | null;
  data_wipe_method: string | null;
  notes: string | null;
  audit_kind: string | null;
  operator_name: string | null;
  restore_image_status: string | null;
  restore_image_name: string | null;
  asset_name: string;
  asset_tag: string;
  unit_id: string | null;
  serial_number: string | null;
  device_type: string | null;
  auditor_name: string | null;
  // The components AS THIS EVENT RECORDED THEM. Deliberately the audit row's
  // own snapshot, not the asset's current profile: this feed is the compliance
  // trail, and it must show the machine as it was when the technician saw it,
  // even if the device was re-audited or re-fitted afterwards. Optional so
  // callers constructing rows for the grouping logic need not supply them.
  hardware_profile?: unknown;
  manufacturer?: string | null;
  model?: string | null;
  cpu?: string | null;
  ram_gb?: number | null;
  storage_capacity?: string | null;
  screen_size?: string | null;
  screen_resolution?: string | null;
  battery_health?: string | null;
}

// The device's components for the day, merged like every other field here:
// last non-null wins, so a later event's fuller capture supersedes an earlier
// partial one without erasing what the earlier one established.
export interface AuditDaySpec {
  hardwareProfile: unknown | null;
  manufacturer: string | null;
  model: string | null;
  cpu: string | null;
  ramGb: number | null;
  storageCapacity: string | null;
  screenSize: string | null;
  screenResolution: string | null;
  batteryHealth: string | null;
}

export interface AuditDayDevice {
  assetId: string;
  name: string;
  tag: string;
  unitId: string | null;
  serialNumber: string | null;
  deviceType: string | null;
  firstAt: string;
  lastAt: string;
  // Merged view of the day: the LAST non-null value wins within each field,
  // mirroring how the denormalized asset columns are maintained. The raw
  // events below stay untouched — they are the compliance trail.
  auditStatus: string | null;
  cosmeticGrade: string | null;
  dataWipeStatus: string | null;
  dataWipeMethod: string | null;
  auditKind: string | null;
  restoreImageStatus: string | null;
  restoreImageName: string | null;
  // Who touched the device that day: the station's operator_name where the
  // event carries one (the human), else the account that uploaded it.
  auditors: string[];
  // Carried once per DEVICE, never per event: a day of 100 machines would
  // otherwise ship the same profile blob four times over for one session.
  spec: AuditDaySpec;
  events: {
    id: string;
    at: string;
    auditStatus: string | null;
    cosmeticGrade: string | null;
    dataWipeStatus: string | null;
    dataWipeMethod: string | null;
    restoreImageStatus: string | null;
    restoreImageName: string | null;
    auditKind: string | null;
    notes: string | null;
    auditor: string | null;
  }[];
}

// Does this profile blob actually describe components, or is it just an
// identity stub?
//
// Every event stores a normalised profile, so a wipe posted for an already
// known machine lands as {identification:{serialNumber}} — non-null, but
// carrying no hardware. A plain last-non-null rule lets that stub overwrite
// the capture's full profile and the workspace then renders a machine with no
// components. Only a blob holding at least one component section may replace
// the one already merged.
const COMPONENT_SECTIONS = [
  'cpu',
  'memory',
  'storage',
  'graphics',
  'display',
  'battery',
  'system',
] as const;

export function hasComponents(profile: unknown): boolean {
  if (profile == null || typeof profile !== 'object') return false;
  const p = profile as Record<string, unknown>;
  return COMPONENT_SECTIONS.some((k) => {
    const v = p[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'object' && Object.keys(v as object).length > 0;
  });
}

// Collapse a day's event rows (ordered oldest-first) into one entry per
// device. Exported for its spec — this is the merge the whole workspace's
// honesty depends on.
export function groupDayEvents(rows: DayEventRow[]): AuditDayDevice[] {
  const byAsset = new Map<string, AuditDayDevice>();
  for (const r of rows) {
    let d = byAsset.get(r.asset_id);
    if (!d) {
      d = {
        assetId: r.asset_id,
        name: r.asset_name,
        tag: r.asset_tag,
        unitId: r.unit_id,
        serialNumber: r.serial_number,
        deviceType: r.device_type,
        firstAt: r.created_at,
        lastAt: r.created_at,
        auditStatus: null,
        cosmeticGrade: null,
        dataWipeStatus: null,
        dataWipeMethod: null,
        auditKind: null,
        restoreImageStatus: null,
        restoreImageName: null,
        auditors: [],
        spec: {
          hardwareProfile: null,
          manufacturer: null,
          model: null,
          cpu: null,
          ramGb: null,
          storageCapacity: null,
          screenSize: null,
          screenResolution: null,
          batteryHealth: null,
        },
        events: [],
      };
      byAsset.set(r.asset_id, d);
    }
    d.lastAt = r.created_at;
    if (r.audit_status != null) d.auditStatus = r.audit_status;
    if (r.cosmetic_grade != null) d.cosmeticGrade = r.cosmetic_grade;
    if (r.data_wipe_status != null) d.dataWipeStatus = r.data_wipe_status;
    if (r.data_wipe_method != null) d.dataWipeMethod = r.data_wipe_method;
    if (r.audit_kind != null) d.auditKind = r.audit_kind;
    if (r.restore_image_status != null) d.restoreImageStatus = r.restore_image_status;
    if (r.restore_image_name != null) d.restoreImageName = r.restore_image_name;
    // Not simply last-non-null: see hasComponents above — an identity-only
    // stub must not displace a real capture.
    if (hasComponents(r.hardware_profile)) d.spec.hardwareProfile = r.hardware_profile;
    if (r.manufacturer != null) d.spec.manufacturer = r.manufacturer;
    if (r.model != null) d.spec.model = r.model;
    if (r.cpu != null) d.spec.cpu = r.cpu;
    if (r.ram_gb != null) d.spec.ramGb = r.ram_gb;
    if (r.storage_capacity != null) d.spec.storageCapacity = r.storage_capacity;
    if (r.screen_size != null) d.spec.screenSize = r.screen_size;
    if (r.screen_resolution != null) d.spec.screenResolution = r.screen_resolution;
    if (r.battery_health != null) d.spec.batteryHealth = r.battery_health;
    // The station's operator field names the human; the joined account name is
    // the shared kiosk login and only stands in when no operator was recorded.
    const who = r.operator_name || r.auditor_name;
    if (who && !d.auditors.includes(who)) d.auditors.push(who);
    d.events.push({
      id: r.id,
      at: r.created_at,
      auditStatus: r.audit_status,
      cosmeticGrade: r.cosmetic_grade,
      dataWipeStatus: r.data_wipe_status,
      dataWipeMethod: r.data_wipe_method,
      restoreImageStatus: r.restore_image_status,
      restoreImageName: r.restore_image_name,
      auditKind: r.audit_kind,
      notes: r.notes,
      auditor: who ?? null,
    });
  }
  // Devices newest-activity-first; each device's events newest-first for
  // display (they arrived oldest-first so the merge above reads forward).
  const devices = [...byAsset.values()];
  for (const d of devices) d.events.reverse();
  devices.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  return devices;
}

@Injectable()
export class AuditsService {
  constructor(@InjectRepository(AssetAudit) private audits: Repository<AssetAudit>) {}

  // Scoped managers see only audits on devices in lots they own (or pool
  // lots) — the same rule every other list applies via common/ownership.ts,
  // expressed inline because these are raw parameterised queries.
  private scope(user: RequestUser | undefined, params: unknown[]): { join: string; where: string } {
    if (!isScopedManager(user)) return { join: '', where: '' };
    params.push(user!.userId);
    return {
      join: `LEFT JOIN "batches" b ON b."id" = a."batch_id"`,
      where: `AND (b."owner_id" = $${params.length} OR b."owner_id" IS NULL)`,
    };
  }

  async days(
    user?: RequestUser,
    limit = 30,
    kind?: AuditKindFilter,
  ): Promise<AuditDaySummary[]> {
    const params: unknown[] = [];
    const { join, where } = this.scope(user, params);
    const kindWhere = kindClause(kind, params);
    params.push(Math.min(Math.max(limit, 1), 120));
    const rows: { day: string; devices: number; events: number }[] =
      await this.audits.manager.query(
        `SELECT ${LONDON_DAY}::text AS day,
                COUNT(DISTINCT aa."asset_id")::int AS devices,
                COUNT(*)::int AS events
         FROM "asset_audits" aa
         JOIN "assets" a ON a."id" = aa."asset_id"
         ${join}
         WHERE TRUE ${where} ${kindWhere}
         GROUP BY 1
         ORDER BY 1 DESC
         LIMIT $${params.length}`,
        params,
      );
    return rows;
  }

  async day(
    day: string,
    user?: RequestUser,
    kind?: AuditKindFilter,
  ): Promise<AuditDayDevice[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new BadRequestException('day must be YYYY-MM-DD');
    }
    const params: unknown[] = [day];
    const { join, where } = this.scope(user, params);
    const kindWhere = kindClause(kind, params);
    const rows: DayEventRow[] = await this.audits.manager.query(
      `SELECT aa."id", aa."asset_id", aa."created_at", aa."audit_status",
              aa."cosmetic_grade", aa."data_wipe_status", aa."data_wipe_method",
              aa."notes", aa."audit_kind", aa."operator_name",
              aa."restore_image_status", aa."restore_image_name",
              aa."hardware_profile", aa."manufacturer", aa."model", aa."cpu",
              aa."ram_gb", aa."storage_capacity", aa."screen_size",
              aa."screen_resolution", aa."battery_health",
              a."name" AS asset_name, a."tag" AS asset_tag, a."unit_id",
              a."serial_number", a."device_type",
              u."name" AS auditor_name
       FROM "asset_audits" aa
       JOIN "assets" a ON a."id" = aa."asset_id"
       LEFT JOIN "users" u ON u."id" = aa."audited_by_id"
       ${join}
       WHERE ${LONDON_DAY} = $1::date ${where} ${kindWhere}
       ORDER BY aa."created_at" ASC`,
      params,
    );
    return groupDayEvents(rows);
  }
}
