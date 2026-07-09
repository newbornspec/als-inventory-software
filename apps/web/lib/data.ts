import { apiFetch } from '@/lib/api-server';

export interface Location {
  id: string;
  name: string;
  address: string | null;
}

export function getLocations(): Promise<Location[]> {
  return apiFetch<Location[]>('/locations');
}
