import type { Route } from './types';
import { compactPath } from './routeChanges';

// Compare exact paths: prepending changes still matter even if simplified labels collapse repeats.
export function meaningful(event: Route): boolean {
  if (event.type === 'snapshot') return false;
  if (event.type === 'withdrawal') return Boolean(event.previous_path?.length);
  return event.as_path.join(',') !== (event.previous_path ?? []).join(',');
}
export function plainChange(event: Route): string {
  if (event.type === 'withdrawal') return meaningful(event) ? 'Stopped reporting a route' : 'Repeated withdrawal';
  if (!event.previous_path?.length) return 'Started reporting a route';
  return meaningful(event) ? 'Changed route' : 'Same route reported again';
}
export function routePatterns(routes: Route[]) {
  const groups = new Map<string, { key: string; via: number[]; routes: Route[] }>();
  for (const route of routes) {
    const path = compactPath(route.as_path);
    // Group by the full suffix after the observation network, preserving all intermediate ASNs.
    const via = path.slice(1);
    const key = JSON.stringify([route.prefix, via]);
    if (!groups.has(key)) groups.set(key, { key, via, routes: [] });
    groups.get(key)!.routes.push(route);
  }
  return [...groups.values()].sort((a, b) => b.routes.length - a.routes.length || a.key.localeCompare(b.key));
}
