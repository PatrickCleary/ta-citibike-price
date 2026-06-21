// Server-data hooks (react-query).
//
// Per-station reach + routes are immutable, so we cache them forever and never
// refetch. Queries stay disabled until a station is picked. This replaces the
// component's manual loading/error/data bookkeeping.

import { useQuery } from "@tanstack/react-query";
import { fetchReach } from "./sheds";
import { fetchRoutes } from "./trips";

export function useReach(stationId: string | null) {
  return useQuery({
    queryKey: ["reach", stationId],
    queryFn: () => fetchReach(stationId!),
    enabled: stationId != null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useRoutes(stationId: string | null) {
  return useQuery({
    queryKey: ["routes", stationId],
    queryFn: () => fetchRoutes(stationId!),
    enabled: stationId != null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
