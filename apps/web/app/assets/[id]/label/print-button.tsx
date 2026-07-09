'use client';

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white"
    >
      Print label
    </button>
  );
}
