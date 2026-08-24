/** All timestamps in Turminder are ISO 8601 UTC with milliseconds (spec preamble). */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(d: Date): string {
  return d.toISOString();
}

export function isoPlusSeconds(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

export function isoPlusMs(ms: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}

/** Milliseconds until an ISO timestamp; negative when already past. */
export function msUntil(iso: string, from: Date = new Date()): number {
  return Date.parse(iso) - from.getTime();
}

export function isPast(iso: string, from: Date = new Date()): boolean {
  return Date.parse(iso) <= from.getTime();
}

export function parseIso(iso: string): Date | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}
