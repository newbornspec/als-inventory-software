import { groupDayEvents, hasComponents, type DayEventRow } from './audits.service';

// The merge the Audit workspace's honesty depends on: the kiosk files SEVERAL
// asset_audits rows for one machine in one session (the capture posts one,
// then each wiped drive posts another), so a naive per-row feed would show a
// day's work double and render a securely-erased laptop twice — once with the
// audit tick and once with the wipe tick, neither row showing both.

function row(over: Partial<DayEventRow>): DayEventRow {
  return {
    id: over.id ?? 'e1',
    asset_id: over.asset_id ?? 'a1',
    created_at: over.created_at ?? '2026-08-22T09:00:00.000Z',
    audit_status: null,
    cosmetic_grade: null,
    data_wipe_status: null,
    data_wipe_method: null,
    notes: null,
    audit_kind: null,
    operator_name: null,
    restore_image_status: null,
    restore_image_name: null,
    asset_name: 'Latitude 7490',
    asset_tag: 'SN123',
    unit_id: 'U-000001',
    serial_number: 'SN123',
    device_type: 'Laptop',
    auditor_name: null,
    ...over,
  };
}

describe('groupDayEvents', () => {
  it('collapses a capture + wipe session into ONE device with both facts', () => {
    const devices = groupDayEvents([
      row({ id: 'e1', created_at: '2026-08-22T09:00:00Z', audit_status: 'power_on', cosmetic_grade: 'grade_b' }),
      row({ id: 'e2', created_at: '2026-08-22T09:40:00Z', audit_status: 'data_wiped', data_wipe_status: 'wiped', data_wipe_method: 'NIST 800-88' }),
    ]);
    expect(devices).toHaveLength(1);
    const d = devices[0];
    expect(d.events).toHaveLength(2);
    // Later non-null wins; earlier facts survive where the later row is null.
    expect(d.auditStatus).toBe('data_wiped');
    expect(d.cosmeticGrade).toBe('grade_b');
    expect(d.dataWipeStatus).toBe('wiped');
    expect(d.dataWipeMethod).toBe('NIST 800-88');
  });

  it('a later null never erases an earlier fact (plain re-capture after a wipe)', () => {
    const d = groupDayEvents([
      row({ id: 'e1', created_at: '2026-08-22T09:00:00Z', data_wipe_status: 'wiped' }),
      row({ id: 'e2', created_at: '2026-08-22T10:00:00Z', audit_status: 'power_on' }),
    ])[0];
    expect(d.dataWipeStatus).toBe('wiped');
    expect(d.auditStatus).toBe('power_on');
  });

  it('keeps the components the capture recorded when the wipe event carries none', () => {
    // The session's first event holds the hardware; the wipe row that follows
    // has every spec column null. Blanking on the later row would leave the
    // workspace showing a machine with no components — the exact failure the
    // last-non-null rule exists to prevent.
    const d = groupDayEvents([
      row({
        id: 'e1',
        created_at: '2026-08-22T09:00:00Z',
        audit_status: 'power_on',
        hardware_profile: { cpu: { model: 'Core i7-4770' } },
        cpu: 'Core i7-4770',
        ram_gb: 8,
        storage_capacity: '256GB',
      }),
      row({ id: 'e2', created_at: '2026-08-22T09:40:00Z', data_wipe_status: 'wiped' }),
    ])[0];
    expect(d.spec.hardwareProfile).toEqual({ cpu: { model: 'Core i7-4770' } });
    expect(d.spec.cpu).toBe('Core i7-4770');
    expect(d.spec.ramGb).toBe(8);
    expect(d.spec.storageCapacity).toBe('256GB');
  });

  it('an identity-only profile stub never displaces a real capture', () => {
    // The shape live traffic actually produces: ingest normalises and stores a
    // profile on EVERY event, so a wipe filed against a known machine lands as
    // {identification:{serialNumber}} — non-null but component-free. A plain
    // last-non-null rule let that stub win and the workspace rendered a laptop
    // with no components. Caught in the browser, not by the first test here.
    const d = groupDayEvents([
      row({
        id: 'e1',
        created_at: '2026-08-22T09:00:00Z',
        hardware_profile: {
          identification: { serialNumber: 'GJDNG63' },
          cpu: { model: 'Core i5-8265U' },
          storage: [{ capacity: '256GB', serialNumber: 'S4EV' }],
        },
      }),
      row({
        id: 'e2',
        created_at: '2026-08-22T09:40:00Z',
        data_wipe_status: 'wiped',
        hardware_profile: { identification: { serialNumber: 'GJDNG63' } },
      }),
    ])[0];
    expect(d.spec.hardwareProfile).toMatchObject({ cpu: { model: 'Core i5-8265U' } });
  });

  it('hasComponents distinguishes a real capture from a stub', () => {
    expect(hasComponents(null)).toBe(false);
    expect(hasComponents({})).toBe(false);
    expect(hasComponents({ identification: { serialNumber: 'X' } })).toBe(false);
    expect(hasComponents({ storage: [] })).toBe(false); // present but empty
    expect(hasComponents({ cpu: {} })).toBe(false); // section with nothing in it
    expect(hasComponents({ cpu: { model: 'i7' } })).toBe(true);
    expect(hasComponents({ storage: [{ capacity: '256GB' }] })).toBe(true);
    expect(hasComponents({ battery: { cycleCount: 12 } })).toBe(true);
  });

  it('a later, fuller capture supersedes an earlier partial one', () => {
    const d = groupDayEvents([
      row({ id: 'e1', created_at: '2026-08-22T09:00:00Z', ram_gb: 8 }),
      row({ id: 'e2', created_at: '2026-08-22T11:00:00Z', ram_gb: 16, cpu: 'Core i5-8365U' }),
    ])[0];
    expect(d.spec.ramGb).toBe(16);
    expect(d.spec.cpu).toBe('Core i5-8365U');
  });

  it('records no components when the audits carried none', () => {
    const d = groupDayEvents([row({ id: 'e1', audit_status: 'power_on' })])[0];
    expect(d.spec.hardwareProfile).toBeNull();
    expect(d.spec.cpu).toBeNull();
  });

  it('the profile blob rides once per device, never on each event', () => {
    // A day of 100 machines would otherwise ship the same blob four times over
    // for a single session.
    const d = groupDayEvents([
      row({ id: 'e1', hardware_profile: { cpu: { model: 'i7' } } }),
      row({ id: 'e2', created_at: '2026-08-22T09:40:00Z' }),
    ])[0];
    expect(d.spec.hardwareProfile).not.toBeNull();
    for (const e of d.events) {
      expect(e).not.toHaveProperty('hardwareProfile');
    }
  });

  it('counts devices, not events — the dual-disk double-wipe case', () => {
    const devices = groupDayEvents([
      row({ id: 'e1', asset_id: 'a1', created_at: '2026-08-22T09:00:00Z' }),
      row({ id: 'e2', asset_id: 'a1', created_at: '2026-08-22T09:30:00Z', data_wipe_status: 'wiped' }),
      row({ id: 'e3', asset_id: 'a1', created_at: '2026-08-22T09:31:00Z', data_wipe_status: 'wiped' }),
      row({ id: 'e4', asset_id: 'a2', created_at: '2026-08-22T11:00:00Z', asset_name: 'EliteBook' }),
    ]);
    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.assetId === 'a1')!.events).toHaveLength(3);
  });

  it("orders devices by latest activity and each device's events newest-first", () => {
    const devices = groupDayEvents([
      row({ id: 'e1', asset_id: 'a1', created_at: '2026-08-22T09:00:00Z' }),
      row({ id: 'e2', asset_id: 'a2', created_at: '2026-08-22T10:00:00Z' }),
      row({ id: 'e3', asset_id: 'a1', created_at: '2026-08-22T11:00:00Z' }),
    ]);
    expect(devices.map((d) => d.assetId)).toEqual(['a1', 'a2']);
    expect(devices[0].events.map((e) => e.id)).toEqual(['e3', 'e1']);
    expect(devices[0].firstAt).toBe('2026-08-22T09:00:00Z');
    expect(devices[0].lastAt).toBe('2026-08-22T11:00:00Z');
  });

  it('prefers the station operator over the shared kiosk account name', () => {
    // Every kiosk row's audited_by is the one shared login; operator_name is
    // the only field that names the human. When present it must win.
    const d = groupDayEvents([
      row({ id: 'e1', created_at: '2026-08-22T09:00:00Z', auditor_name: 'Ada Admin', operator_name: 'John Doe' }),
      row({ id: 'e2', created_at: '2026-08-22T09:30:00Z', auditor_name: 'Ada Admin' }),
    ])[0];
    expect(d.auditors).toEqual(['John Doe', 'Ada Admin']);
    expect(d.events.find((e) => e.id === 'e1')!.auditor).toBe('John Doe');
  });

  it('merges kind and restore-image facts like every other field', () => {
    const d = groupDayEvents([
      row({ id: 'e1', created_at: '2026-08-22T09:00:00Z', audit_kind: 'amazon' }),
      row({ id: 'e2', created_at: '2026-08-22T10:00:00Z', restore_image_status: 'installed', restore_image_name: 'Win11 Pro 23H2' }),
    ])[0];
    expect(d.auditKind).toBe('amazon');
    expect(d.restoreImageStatus).toBe('installed');
    expect(d.restoreImageName).toBe('Win11 Pro 23H2');
  });

  it('collects distinct auditors and tolerates the NULL-author history', () => {
    const d = groupDayEvents([
      row({ id: 'e1', created_at: '2026-08-22T09:00:00Z', auditor_name: 'Ada Admin' }),
      row({ id: 'e2', created_at: '2026-08-22T09:30:00Z', auditor_name: null }),
      row({ id: 'e3', created_at: '2026-08-22T10:00:00Z', auditor_name: 'Ada Admin' }),
    ])[0];
    expect(d.auditors).toEqual(['Ada Admin']);
    expect(d.events.find((e) => e.id === 'e2')!.auditor).toBeNull();
  });
});
