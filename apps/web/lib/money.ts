export function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return '£' + n.toFixed(2);
}
