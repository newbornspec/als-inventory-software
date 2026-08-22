'use client';

import { useId, useState } from 'react';
import {
  ACTION_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  MODULE_PERMISSIONS,
} from '@/lib/permissions';

// The ACCESS / ACTIONS checkbox grid from the client spec's user screen.
// Checked boxes submit as repeated `permissions` form fields, so the server
// action reads them with formData.getAll('permissions'). Selecting a role
// resets the grid to that role's baseline — same rule the API applies when a
// role changes without explicit grants — and any box toggled after that is a
// deliberate per-user deviation.
export function PermissionsPicker({
  role,
  initial,
  initialRole,
}: {
  role: string;
  // The user's saved grants, shown when `role` matches `initialRole` — so on
  // the edit screen, flipping the role away and back restores what was
  // actually saved rather than the role's defaults.
  initial?: string[];
  initialRole?: string;
}) {
  const uid = useId();
  const grantsFor = (r: string) =>
    initial && r === (initialRole ?? role) ? initial : (DEFAULT_PERMISSIONS[r] ?? []);
  const [selected, setSelected] = useState<Set<string>>(new Set(grantsFor(role)));
  // Tracks the role whose baseline the grid currently shows, so a re-render
  // with the same role never wipes the admin's hand-edits.
  const [baselineRole, setBaselineRole] = useState(role);

  if (role !== baselineRole) {
    setBaselineRole(role);
    setSelected(new Set(grantsFor(role)));
  }

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  const groups = [
    { legend: 'Access', hint: 'Which areas of the app this user can open.', items: MODULE_PERMISSIONS },
    { legend: 'Actions', hint: 'What this user is allowed to do inside them.', items: ACTION_PERMISSIONS },
  ];

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <fieldset key={group.legend} className="rounded-md border border-neutral-200 p-3">
          <legend className="px-1 text-sm font-medium text-neutral-800">{group.legend}</legend>
          <p className="text-xs text-neutral-600">{group.hint}</p>
          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {group.items.map((perm) => (
              <label
                key={perm.slug}
                htmlFor={`${uid}-${perm.slug}`}
                title={perm.hint}
                className="flex items-start gap-2 rounded px-1.5 py-1 text-sm text-neutral-800 hover:bg-neutral-50"
              >
                <input
                  id={`${uid}-${perm.slug}`}
                  type="checkbox"
                  name="permissions"
                  value={perm.slug}
                  checked={selected.has(perm.slug)}
                  onChange={() => toggle(perm.slug)}
                  className="mt-0.5"
                />
                <span>{perm.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="text-xs text-neutral-600">
        Changing the role resets these to that role&rsquo;s standard set. Admins always have full
        access regardless of what is ticked here.
      </p>
    </div>
  );
}
