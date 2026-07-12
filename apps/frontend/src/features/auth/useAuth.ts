import { useQuery } from '@tanstack/react-query';
import { getSessions } from '@/lib/api';

/**
 * Lightweight auth probe. There is no dedicated `/me` endpoint, so we treat a
 * successful (non-401) `GET /api/sessions` as proof of authentication. The
 * `request` wrapper in lib/api.ts already redirects to /login on 401, so this
 * hook mainly powers client-side redirects (e.g. skipping login when already
 * authed).
 */
export function useAuth() {
  const query = useQuery({
    queryKey: ['auth', 'probe'],
    queryFn: getSessions,
    retry: false,
    staleTime: 30_000,
  });

  return {
    isAuthenticated: query.isSuccess,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
