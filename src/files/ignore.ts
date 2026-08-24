/**
 * `.turminderignore` (App. G.11): gitignore syntax, hand-rolled because the
 * dependency list is a spec decision (App. J) and this is a small, well-defined
 * grammar. Supported: comments, blank lines, `!` negation, trailing `/` for
 * directories, leading or embedded `/` for root-anchoring, `*`, `?`, `**`.
 * Not supported: character classes, escaped `#`/`!`, trailing-space escapes.
 */

interface Rule {
  source: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function toRegExp(body: string, anchored: boolean): RegExp {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // `**/` spans whole path segments, including none at all.
        if (body[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A matched directory takes everything under it with it.
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}(?:/.*)?$`);
}

export class IgnoreRules {
  private constructor(private readonly rules: Rule[]) {}

  static parse(text: string): IgnoreRules {
    const rules: Rule[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      let body = negate ? line.slice(1) : line;
      const dirOnly = body.endsWith('/');
      if (dirOnly) body = body.slice(0, -1);
      const anchored = body.startsWith('/') || body.slice(0, -1).includes('/');
      if (body.startsWith('/')) body = body.slice(1);
      if (!body) continue;
      rules.push({ source: line, re: toRegExp(body, anchored), negate, dirOnly });
    }
    return new IgnoreRules(rules);
  }

  static empty(): IgnoreRules {
    return new IgnoreRules([]);
  }

  get size(): number {
    return this.rules.length;
  }

  /**
   * Whether a store-relative posix path is excluded. Later rules win, which is
   * what makes `!keep-this` after a broad pattern work.
   */
  ignores(rel: string, isDir = false): boolean {
    if (!rel) return false;
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir && !rule.re.test(`${rel}/`) && !dirPrefixMatch(rule, rel)) {
        continue;
      }
      if (!rule.re.test(rel)) continue;
      ignored = !rule.negate;
    }
    return ignored;
  }

  /** Which rule excluded a path — for explaining a surprise to the user. */
  reasonFor(rel: string, isDir = false): string | null {
    if (!this.ignores(rel, isDir)) return null;
    for (const rule of [...this.rules].reverse()) {
      if (!rule.negate && rule.re.test(rel)) return rule.source;
    }
    return null;
  }
}

/**
 * A directory-only pattern still excludes a file inside a matching directory,
 * so `.obsidian/` hides `.obsidian/workspace.json`.
 */
function dirPrefixMatch(rule: Rule, rel: string): boolean {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    if (rule.re.test(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}
