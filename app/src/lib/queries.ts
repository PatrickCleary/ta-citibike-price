// Server-data hooks (react-query).
//
// Per-station reach, routes + walksheds are immutable, so we cache them forever and never
// refetch. Queries stay disabled until a station is picked. This replaces the
// component's manual loading/error/data bookkeeping.

import { useQuery } from "@tanstack/react-query";
import { fetchReach } from "./sheds";
import { fetchRoutes } from "./trips";
import { fetchWalkshed } from "./walksheds";

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

export function useWalkshed(stationId: string | null) {
  return useQuery({
    queryKey: ["walkshed", stationId],
    queryFn: () => fetchWalkshed(stationId!),
    enabled: stationId != null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
