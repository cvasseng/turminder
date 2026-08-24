/**
 * The one glob implementation, used for tool grants (App. F.7) and envelope
 * matchers (§5.2). `*` spans dots so `*` alone matches everything and
 * `email.*` matches `email.received`; `?` matches one character.
 */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

const cache = new Map<string, RegExp>();

export function globMatch(pattern: string, value: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = toRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(value);
}

export function globMatchAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}
