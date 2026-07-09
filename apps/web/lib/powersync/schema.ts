import { column, Schema, Table } from '@powersync/web';

// Mirrors the writable subset of the Postgres schema (see apps/api entities).
// Reference tables (locations, users) are synced read-only for lookups;
// assets, asset_history, and asset_audits are the tables scanning/auditing writes to.
export const AppSchema = new Schema({
  assets: new Table({
    tag: column.text,
    name: column.text,
    category: column.text,
    stock_status: column.text,
    condition_grade: column.text,
    audit_status: column.text,
    location_id: column.text,
    owner_id: column.text,
    image_url: column.text,
    warranty_expires_at: column.text,
    batch_id: column.text,
    lot_id: column.text,
    updated_at: column.text,
  }),
  asset_history: new Table({
    asset_id: column.text,
    event_type: column.text,
    user_id: column.text,
    notes: column.text,
    created_at: column.text,
  }),
  // A field technician records a full ITAD audit here with zero signal —
  // functional_tests is stored as a JSON-encoded text column locally (SQLite
  // has no native JSON type); the server side has it as real jsonb.
  asset_audits: new Table({
    asset_id: column.text,
    audit_status: column.text,
    manufacturer: column.text,
    model: column.text,
    serial_number: column.text,
    cpu: column.text,
    ram_gb: column.integer,
    storage_capacity: column.text,
    screen_size: column.text,
    screen_resolution: column.text,
    battery_health: column.text,
    cosmetic_grade: column.text,
    functional_tests: column.text,
    bios_locked: column.integer,
    charger_included: column.integer,
    data_wipe_status: column.text,
    data_wipe_method: column.text,
    final_disposition: column.text,
    notes: column.text,
    audited_by_id: column.text,
    created_at: column.text,
  }),
  locations: new Table({
    name: column.text,
    address: column.text,
    assigned_user_id: column.text,
  }),
  // Read-only reference data — batches/lots are created online (see
  // /batches in the web UI); the scan page just needs to list open ones so
  // a technician can pick which batch they're receiving assets into.
  batches: new Table({
    batch_number: column.text,
    source: column.text,
    location_id: column.text,
    expected_unit_count: column.integer,
    status: column.text,
  }),
  lots: new Table({
    lot_number: column.text,
    batch_id: column.text,
    description: column.text,
    expected_unit_count: column.integer,
    status: column.text,
  }),
});

export type Database = (typeof AppSchema)['types'];
