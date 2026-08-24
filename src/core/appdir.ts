import fs from 'node:fs';
import path from 'node:path';

/**
 * Locates a directory that ships *beside* the code rather than inside the
 * compiler's output — `ui/` (§28.4) and the browser libraries served straight
 * from `node_modules/` (§23.3, §22.3).
 *
 * The distance from a module to that tree root is not a constant: `rootDir` is
 * the repo, so `src/net/static.ts` sits two levels under it and the built
 * `dist/src/net/static.js` sits three. A hard-coded `../..` is therefore
 * correct in exactly one of the two, which is how `npm start` came to answer
 * `/` with a missing-asset error while `npm run dev` served the page. So count
 * nothing and search: the packaged sidecar (`dist/`, `ui/` and `node_modules/`
 * as siblings) and an install under someone else's `node_modules/` then fall
 * out of the same walk.
 */
export function appDir(name: string, from: string): string {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Nowhere above us: return a path that cannot resolve rather than throwing.
  // A tree assembled without `ui/` still has to answer `/healthz` and fail on
  // `/` — that pair is what the §28.4 bundle smoke test reads.
  return path.join(path.resolve(from), name);
}
