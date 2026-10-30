import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SettingsResponse } from '@/lib/types';

export function useAppSettings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/api/settings'), staleTime: 60_000 });
  return { ...q, timezone: q.data?.settings.timezone ?? 'America/Belem' };
}
