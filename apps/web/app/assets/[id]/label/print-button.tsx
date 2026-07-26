'use client';

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="w-full rounded-md bg-[#2b7fff] py-2 text-sm font-medium text-white hover:bg-blue-600"
    >
      Print label
    </button>
  );
}
