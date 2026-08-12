import Fuse from 'fuse.js';
import type { StationPoint } from './dockController';

export function createStationSearcher(stations: StationPoint[]) {
  const fuse = new Fuse(stations, {
    keys: ['name'],
    threshold: 0.3,
    distance: 100,
  });

  return (query: string, limit = 5) => {
    const result = fuse.search(query, { limit });
    return result.map(r => r.item);
  }
}