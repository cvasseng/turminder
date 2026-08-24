import { log } from '../core/logger.js';
import { nowIso } from '../core/time.js';
import { writeGrants, type Config } from '../core/config.js';
import type { GrantLevel, GrantRecord } from '../core/config-schemas.js';
import type { DataHome } from '../core/datadir.js';
import { globMatchAny } from '../core/glob.js';
import type { Grants } from './dispatcher.js';

const l = log('grants');

export interface GrantInput {
  pattern: string;
  level: GrantLevel;
  reason?: string;
  source?: string;
}

/**
 * Runtime tool access (App. F.7). The configured `chat.tools` set covers what
 * ships; this covers what the user said yes to afterwards — the tools of an MCP
 * server they installed, most of the time.
 *
 * It is a separate store rather than an edit to `chat.tools` for two reasons:
 * the record keeps why and when, and the file is carved out of `config.write`,
 * so the only way into it is a human submitting a form. An agent that can grant
 * itself a capability has not been granted anything.
 */
export class GrantStore {
  constructor(
    private readonly home: DataHome,
    /** Read at call time: a grant must take effect without a restart. */
    private readonly config: Config,
  ) {}

  records(): GrantRecord[] {
    try {
      return this.config.grants().grants;
    } catch (e) {
      // A hand-edited grants.yaml with a typo must not take chat down; it just
      // means the runtime grants are ignored until it is fixed.
      l.error({ err: (e as Error).message }, 'config/grants.yaml is unusable; ignoring it');
      return [];
    }
  }

  /** Additional patterns for a dispatcher, on top of the configured set. */
  patterns(): Grants {
    const records = this.records();
    return {
      tools: records.filter((g) => g.level === 'tools').map((g) => g.pattern),
      confirm: records.filter((g) => g.level === 'confirm').map((g) => g.pattern),
    };
  }

  /** The configured grant plus everything granted since, ready for a run. */
  merged(base: Grants): Grants {
    const extra = this.patterns();
    return {
      tools: [...(base.tools ?? []), ...(extra.tools ?? [])],
      confirm: [...(base.confirm ?? []), ...(extra.confirm ?? [])],
    };
  }

  /** Whether a tool name is already reachable under `base` plus the records. */
  covers(base: Grants, tool: string): GrantLevel | null {
    const merged = this.merged(base);
    if (globMatchAny(merged.confirm ?? [], tool)) return 'confirm';
    if (globMatchAny(merged.tools ?? [], tool)) return 'tools';
    return null;
  }

  /**
   * Record grants and commit. Re-granting the same pattern replaces it, so
   * changing your mind about the level is one submit rather than two files.
   */
  add(inputs: GrantInput[], message: string): GrantRecord[] {
    const existing = this.records();
    const replacing = new Set(inputs.map((i) => i.pattern));
    const added: GrantRecord[] = inputs.map((input) => ({
      pattern: input.pattern,
      level: input.level,
      granted_at: nowIso(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.source ? { source: input.source } : {}),
    }));
    const grants = [...existing.filter((g) => !replacing.has(g.pattern)), ...added];
    writeGrants(this.home, { grants }, message);
    this.config.reload();
    return added;
  }
}
