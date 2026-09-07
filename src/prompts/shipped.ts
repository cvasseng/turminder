import fs from 'node:fs';
import matter from 'gray-matter';
import { assetHash, type DataHome, type ShippedAssetContent } from '../core/datadir.js';
import { log } from '../core/logger.js';
import { readLibrary } from './library.js';

const l = log('shipped');

/**
 * Documents Turminder ships into the data dir, installed at every start. The
 * rule used to be "write it only when absent, so the user's edits always win",
 * which is right about edits and wrong about everything else: an install froze
 * at its first start and the shipped half of the assistant then aged out from
 * under it — measured on a five-week-old install whose `watch-changed` handler
 * had been failing to load, unheard, for two weeks.
 *
 * §12.3 replaces it with a rule that distinguishes *our* copy from *theirs*
 * and never guesses which it is looking at. The MANIFEST's `shipped:` map
 * (G.10) records the sha256 of what we wrote; four branches follow from it,
 * and `installShippedAssets` runs them in the order §12.3 states.
 *
 * The content lives in `library/{skills,handlers}/<name>.md` — one file per
 * asset, no registry: the directory is the manifest, and a file's category
 * is the data-dir directory it installs into.
 */
export type ShippedAsset = ShippedAssetContent;

const CATEGORIES = ['skills', 'handlers'] as const;

function load(): ShippedAsset[] {
  const assets: ShippedAsset[] = [];
  for (const category of CATEGORIES) {
    for (const file of readLibrary(category)) {
      // The loaders in the data dir silently ignore files with bad
      // frontmatter — for user files that is forgiving, for shipped ones it
      // would mean we shipped a no-op. Fail the build/startup instead.
      const fm = matter(file.content).data as { name?: unknown; description?: unknown };
      if (fm.name !== file.name || typeof fm.description !== 'string' || !fm.description) {
        throw new Error(
          `library/${category}/${file.name}.md: frontmatter must carry name: ${file.name} ` +
            `and a non-empty description`,
        );
      }
      assets.push({ path: `${category}/${file.name}.md`, content: file.content });
    }
  }
  return assets;
}

export const SHIPPED_ASSETS: ShippedAsset[] = load();

/** Why an asset was left alone (§12.3) — what `doctor` reports and why. */
export type DriftReason =
  /** Its recorded hash says we wrote it, and the bytes have since changed. */
  | 'edited'
  /** No recorded hash and the bytes differ from ours: unreadable evidence. */
  | 'unknown';

export interface DriftedAsset {
  path: string;
  reason: DriftReason;
}

export interface ShippedAssetReport {
  /** Written because the data dir had none — including one the user deleted. */
  installed: string[];
  /** Rewritten from the library: the recorded hash still matched, so ours. */
  refreshed: string[];
  /** Byte-identical to ours with no record, so recorded and now tracked. */
  adopted: string[];
  /** Left alone, forever in the `edited` case (§12.3). */
  drifted: DriftedAsset[];
}

function plural(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

/**
 * Install, refresh, adopt or decline every shipped asset (§12.3), then commit
 * whatever moved. One commit per start: a rewrite of a file in the user's own
 * data dir is a mutation of the data repo like any other (§12.2, constitution
 * rule 9), and `git log -p` is the only audit trail they have for it.
 */
export function installShippedAssets(home: DataHome): ShippedAssetReport {
  const report: ShippedAssetReport = {
    installed: [],
    refreshed: [],
    adopted: [],
    drifted: [],
  };
  const recorded = home.shippedHashes();
  const toRecord: Record<string, string> = {};

  for (const asset of SHIPPED_ASSETS) {
    const abs = home.path(asset.path);
    const shippedHash = assetHash(asset.content);

    // Absent -> install, and record. Deleting a shipped asset still brings it
    // back on the next start, which is the property v1 had and kept.
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, asset.content, 'utf8');
      toRecord[asset.path] = shippedHash;
      report.installed.push(asset.path);
      continue;
    }

    const currentHash = assetHash(fs.readFileSync(abs));
    const known = recorded[asset.path];

    if (known === undefined) {
      // No record: adopt only on a byte-for-byte match. Identical content
      // proves nothing was edited; different content could equally be a stale
      // copy or a careful rewrite, and a guess here eats exactly the edits the
      // rule below exists to protect.
      if (currentHash === shippedHash) {
        toRecord[asset.path] = currentHash;
        report.adopted.push(asset.path);
      } else {
        report.drifted.push({ path: asset.path, reason: 'unknown' });
      }
      continue;
    }

    if (known !== currentHash) {
      // Theirs, permanently. No merge, no prompt, no "just this once": a file
      // in the user's own data dir that Turminder rewrites over an edit is a
      // betrayal they cannot audit.
      report.drifted.push({ path: asset.path, reason: 'edited' });
      continue;
    }

    // Ours, and untouched since we wrote it — so it tracks the library.
    if (currentHash !== shippedHash) {
      fs.writeFileSync(abs, asset.content, 'utf8');
      toRecord[asset.path] = shippedHash;
      report.refreshed.push(asset.path);
    }
  }

  home.recordShipped(toRecord);
  commitAssetChanges(home, report);

  if (report.installed.length || report.refreshed.length) {
    l.info(
      { installed: report.installed, refreshed: report.refreshed },
      'shipped assets written',
    );
  }
  if (report.drifted.length) {
    l.info({ drifted: report.drifted }, 'shipped assets left alone: they differ from ours');
  }
  return report;
}

function commitAssetChanges(home: DataHome, report: ShippedAssetReport): void {
  const parts: string[] = [];
  if (report.installed.length) parts.push(`installed ${plural(report.installed.length)}`);
  if (report.refreshed.length) parts.push(`refreshed ${plural(report.refreshed.length)}`);
  if (report.adopted.length) parts.push(`adopted ${plural(report.adopted.length)}`);
  if (!parts.length) return;
  home.git.commit(`shipped assets: ${parts.join(', ')}`, ['handlers', 'skills', 'MANIFEST']);
}

/**
 * `turminder assets refresh` (§12.3): take the shipped version of assets that
 * drifted, explicitly, because a human said to. This is the one path that may
 * overwrite an edit — and it only ever runs on paths the caller named.
 */
export function refreshShippedAssets(
  home: DataHome,
  paths: readonly string[],
): { refreshed: string[]; unknown: string[] } {
  const refreshed: string[] = [];
  const unknown: string[] = [];
  const toRecord: Record<string, string> = {};
  for (const p of paths) {
    const asset = SHIPPED_ASSETS.find((a) => a.path === p);
    if (!asset) {
      unknown.push(p);
      continue;
    }
    fs.writeFileSync(home.path(asset.path), asset.content, 'utf8');
    toRecord[asset.path] = assetHash(asset.content);
    refreshed.push(asset.path);
  }
  home.recordShipped(toRecord);
  if (refreshed.length) {
    home.git.commit(`shipped assets: refreshed ${plural(refreshed.length)} on request`, [
      'handlers',
      'skills',
      'MANIFEST',
    ]);
  }
  return { refreshed, unknown };
}

/**
 * Which shipped assets currently differ from the library, without writing
 * anything — the read half of the same rule, for `doctor` and the two `list`
 * commands (§12.3).
 */
export function driftedShippedAssets(home: DataHome): DriftedAsset[] {
  const recorded = home.shippedHashes();
  const drifted: DriftedAsset[] = [];
  for (const asset of SHIPPED_ASSETS) {
    const abs = home.path(asset.path);
    if (!fs.existsSync(abs)) continue;
    const currentHash = assetHash(fs.readFileSync(abs));
    if (currentHash === assetHash(asset.content)) continue;
    const known = recorded[asset.path];
    // Ours and untouched, merely not refreshed yet — the next start does that.
    // Calling it drift would put a file we are about to rewrite on a list of
    // files we promised never to rewrite.
    if (known === currentHash) continue;
    drifted.push({
      path: asset.path,
      reason: known === undefined ? 'unknown' : 'edited',
    });
  }
  return drifted;
}
