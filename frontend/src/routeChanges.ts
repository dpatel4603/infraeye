import type { Route } from './types';

export function changeLabel(event: Route): string {
  if (event.type === 'withdrawal') return 'Route withdrawn';
  if (!event.previous_path) return 'Route announced';
  return event.previous_path.join(',') === event.as_path.join(',') ? 'Advertisement updated' : 'Path changed';
}
export function compactPath(path: number[]) {
  return path.filter((asn, index) => index === 0 || asn !== path[index - 1]);
}
export function pathLinks(path: number[]) {
  const result = new Set<string>();
  for (let i = 0; i < path.length - 1; i++) if (path[i] !== path[i + 1]) result.add(`${path[i]}-${path[i + 1]}`);
  return result;
}
