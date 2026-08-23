'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { MoreVertical } from 'lucide-react';
import type { Pallet } from '@/lib/actions/pallets';

interface Action {
  label: string;
  hint?: string;
  onSelect: () => void;
}

// The ⋮ menu for one row. Everything a single pallet can do, without hanging
// four buttons off every row.
//
// Rendered through a PORTAL rather than positioned inside the cell. The table
// scrolls horizontally, and `overflow-x: auto` forces the computed
// `overflow-y` to `auto` too — you cannot have one axis clipped and the other
// visible — so a dropdown living inside that container gets cut off at the row
// it opens from. Fixed positioning off the trigger's rect is the way out.
export function RowActions({
  pallet,
  canExport,
  canMerge,
  onMerge,
}: {
  pallet: Pallet;
  // Separate flags, matching the API's separate permissions — a merge-only
  // user must not see an Export item that 403s, nor the reverse.
  canExport: boolean;
  canMerge: boolean;
  onMerge: (id: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // "Only show actions that are valid for that pallet's current state."
  const isMerged = pallet.status === 'merged';
  const isShipped = pallet.status === 'shipped';
  const isEmpty = (pallet.totalQuantity ?? 0) <= 0;

  const actions: Action[] = [
    { label: 'View pallet', onSelect: () => router.push(`/pallets/${pallet.id}`) },
  ];
  if (!isMerged && !isShipped) {
    // The detail page IS the editor for both layouts — Layout 2 opens straight
    // into its grid, Layout 1 edits its lines in place — so Edit goes there
    // with the intent named, rather than inventing a second screen.
    actions.push({
      label: 'Edit contents',
      onSelect: () => router.push(`/pallets/${pallet.id}`),
    });
  }
  if (canExport) {
    actions.push({
      label: 'Export to Excel',
      onSelect: () => window.open(`/api/pallets/${pallet.id}/report`, '_self'),
    });
  }
  if (canMerge && !isMerged && !isShipped && !isEmpty) {
    actions.push({
      label: 'Merge with…',
      hint: 'Selects this pallet — pick one more',
      onSelect: () => onMerge(pallet.id),
    });
  }

  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 224;
    const height = actions.length * 36 + 8;
    // Flip up when there isn't room below, and never run off the right edge.
    const below = window.innerHeight - r.bottom;
    setPos({
      top: below < height + 8 ? Math.max(8, r.top - height - 4) : r.bottom + 4,
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
    });
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const close = () => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % actions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + actions.length) % actions.length);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActive(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActive(actions.length - 1);
      } else if (e.key === 'Tab') {
        // A menu is a single stop: tabbing away dismisses it rather than
        // walking the reader through items they have left behind.
        close();
      }
    }
    function onPointer(e: MouseEvent) {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    // The menu is fixed to a rect captured on open; once the page moves under
    // it that rect is a lie, so dismiss rather than drift.
    const onMove = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, actions.length]);

  // Keep DOM focus on the active item so a screen reader announces it.
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items?.[active]?.focus();
  }, [open, active]);

  function run(a: Action) {
    setOpen(false);
    a.onSelect();
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${pallet.palletNumber}`}
        className="rounded p-1 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <MoreVertical className="size-4" aria-hidden="true" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${pallet.palletNumber}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: 224 }}
            className="z-50 rounded-lg border border-neutral-300 bg-white py-1 shadow-lg"
          >
            {actions.map((a, i) => (
              <button
                key={a.label}
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                onClick={() => run(a)}
                onMouseEnter={() => setActive(i)}
                className="block w-full px-3 py-1.5 text-left text-sm text-neutral-800 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none"
              >
                {a.label}
                {a.hint && (
                  <span className="block text-xs text-neutral-600">{a.hint}</span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
