import fs from 'node:fs';
import path from 'node:path';
import type { DataHome } from '../core/datadir.js';

/** Writable roots for `config.write` (App. F.6). Everything else is refused. */
export const CONFIG_WRITE_ROOTS = ['config', 'handlers', 'skills'] as const;

/**
 * Files inside `config/` that `config.write` may never touch, whatever the
 * grant says (§14.4.1, App. F.6). Each has a human in its only write path:
 *
 * - `mcp.yaml` — an MCP server definition is arbitrary code execution, so it is
 *   installed only through a form the user submits (§19.3).
 * - `integrations.yaml` — written by the activation flows alone (§19.5).
 * - `channels.yaml` — device tokens are CLI-managed (App. E).
 * - `grants.yaml` — a capability an agent can write itself is not one the user
 *   granted, so it goes through `setup.request_access` and a form.
 */
export const CONFIG_WRITE_DENIED: Record<string, string> = {
  'config/mcp.yaml':
    'MCP servers are installed only through the setup form flow — propose one with setup.form, never by writing this file',
  'config/integrations.yaml':
    'integration activation is written only by setup.activate / setup.deactivate',
  'config/channels.yaml': 'device tokens are managed with `turminder token`, not from here',
  'config/grants.yaml':
    'tool access is granted only through setup.request_access, where the user approves it',
};

export class PathRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PathRejected';
  }
}

export interface ResolvedPath {
  abs: string;
  /** Path segments, normalised — `[]` for the root itself. */
  segments: string[];
  /** Posix-style relative path, which is what tools and events speak. */
  rel: string;
}

/**
 * Resolve a relative path underneath `root`: normalised, symlink-free, and
 * provably inside. Shared by `config.write` (App. F.6) and the file store
 * (App. F.8) so the two cannot drift — the containment argument is the same one
 * in both places, and one implementation is one thing to get right.
 */
export function resolveInside(root: string, rel: string): ResolvedPath {
  if (typeof rel !== 'string') throw new PathRejected('path is required');
  if (path.isAbsolute(rel)) throw new PathRejected('path must be relative');
  if (rel.includes('\0')) throw new PathRejected('path contains a null byte');

  const normalised = path.normalize(rel).replace(/^(\.\/)+/, '');
  if (normalised.startsWith('..')) throw new PathRejected('path escapes the root');
  const segments =
    normalised === '' || normalised === '.'
      ? []
      : normalised.split(/[/\\]/).filter((s) => s.length > 0 && s !== '.');

  const abs = path.join(root, ...segments);
  // No symlinks anywhere along the existing part of the path: following one is
  // how a path inside the root ends up writing outside it.
  let cursor = root;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new PathRejected(`path component is a symlink: ${seg}`);
    }
  }
  const resolvedRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  if (segments.length && !path.resolve(abs).startsWith(path.join(resolvedRoot, path.sep))) {
    throw new PathRejected('path escapes the root');
  }
  return { abs, segments, rel: segments.join('/') };
}

/**
 * Resolve a data-dir-relative path for the config integration. Inside one of
 * the allowed roots — `memory/` (the memory agent's), `files/` (the files
 * integration's), `secrets/` and `events.db` are refused regardless of grants.
 */
export function resolveWritablePath(home: DataHome, rel: string): string {
  if (!rel) throw new PathRejected('path is required');
  const { abs, segments } = resolveInside(home.root, rel);

  const root = segments[0];
  if (!root || !CONFIG_WRITE_ROOTS.includes(root as (typeof CONFIG_WRITE_ROOTS)[number])) {
    throw new PathRejected(
      `path must be under ${CONFIG_WRITE_ROOTS.map((r) => `${r}/`).join(', ')} (got "${rel}")`,
    );
  }
  if (segments.length < 2) throw new PathRejected('path must name a file, not a directory');

  const denied = CONFIG_WRITE_DENIED[segments.join('/')];
  if (denied) throw new PathRejected(`${segments.join('/')} is not writable: ${denied}`);
  return abs;
}
