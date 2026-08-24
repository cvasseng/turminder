import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  history: 'readonly',
  navigator: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  WebSocket: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  NodeFilter: 'readonly',
  console: 'readonly',
  marked: 'readonly',
};

const wsBan = [
  { name: 'ws', message: 'only net/ touches sockets (spec App. I)', allowTypeImports: true },
];

// Everything that sits above `db` in the App. I layering.
const aboveDb = [
  'model',
  'tools',
  'net',
  'chat',
  'egress',
  'ingress',
  'exec',
  'memory',
  'rag',
  'files',
  'scheduler',
  'prompts',
  'cli',
  'service.js',
  'app.js',
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'ui/vendor/**',
      'ws-drive.mjs',
      'ws-activity.mjs',
      'dev.mjs',
      // The desktop shell is a packaging tier with its own toolchain (§28.3):
      // the service's lint, typecheck and tests must not need it, or `rm -rf
      // app/` would stop being the clean cut the spec promises.
      'app/**',
    ],
  },
  {
    // Node scripts and fixtures outside the TS program. extension/build.mjs
    // is node, not browser — it assembles the browser-land files (§29.6) but
    // never runs beside them, so it takes node globals, not the block below.
    files: ['test/fixtures/**/*.mjs', 'scripts/**/*.mjs', 'extension/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    /*
     * The extension is a packaging tier (§29.6) but not an opaque one: it is
     * plain browser JavaScript in this repo's voice, so it is linted like
     * `ui/` rather than ignored like `app/`. Deleting the directory still
     * leaves lint green — eslint has nothing to say about files that are not
     * there — so the §29.6 clean cut survives being looked at.
     *
     * `script`, not `module`: these files are injected as classic scripts and
     * share one isolated-world scope, which is why `buildCapture` crosses from
     * engine.js to content.js the way `previewKind` crosses in `ui/`.
     */
    files: ['extension/**/*.js'],
    languageOptions: {
      globals: {
        ...browserGlobals,
        chrome: 'readonly',
        globalThis: 'readonly',
        buildCapture: 'readonly',
      },
      sourceType: 'script',
    },
    ...js.configs.recommended,
  },
  {
    // The chat UI is plain browser JavaScript, no build step (plan §3a).
    // Scripts share one global scope, so a function defined in one file and
    // called from another is the module system here — `marked`, `previewKind`
    // and `TOKEN_KEY` all arrive that way. `TOKEN_KEY` is connect.js's, and
    // every page served at `/` loads connect.js first (§24.3).
    files: ['ui/**/*.js'],
    languageOptions: {
      globals: {
        ...browserGlobals,
        previewKind: 'readonly',
        TOKEN_KEY: 'readonly',
        greetingLine: 'readonly',
      },
      sourceType: 'script',
    },
    ...js.configs.recommended,
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Same shape as the `ui/` block below, and for the same reason: in a
    // no-build extension the cross-file surface *is* the unused-looking
    // declaration. `buildCapture` is called from content.js, and
    // `CAPTURE_NOTE_MAX_CHARS` is the popup's maxlength and the mirror the
    // §29.6 agreement test checks — both live in engine.js because that is the
    // file the tests read.
    files: ['extension/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^(_|buildCapture$|CAPTURE_[A-Z_]+$)' },
      ],
    },
  },
  {
    // After the general rules, or the general block wins: `previewKind` is
    // defined in ui/preview.js and `greeting*` in ui/greeting.js, each called
    // from ui/app.js — which in a no-build UI is what "exported" means.
    // `greetingFor` is reached only through `greetingLine`, and is named here
    // so the boundary test can call it directly.
    files: ['ui/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^(_|previewKind$|greetingFor$|greetingLine$)',
        },
      ],
    },
  },

  // ── Module boundaries (spec App. I), enforced rather than reviewed. ──────
  // Type-only imports are exempt (erased at compile time; no runtime coupling).
  // Two footguns encoded here so nobody re-trips them:
  //  * minimatch wildcards never match `..` segments — every relative escape
  //    needs its literal `../` depth spelled out;
  //  * flat-config blocks override per RULE ID, so a narrower block must carry
  //    the UNION of restrictions (its own patterns + the global `ws` ban),
  //    not just its additions.
  {
    // Only `net` (and the daemon's own transport) touches sockets.
    files: ['src/**/*.ts'],
    ignores: ['src/net/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: wsBan }],
    },
  },
  {
    // `core` imports nothing above itself.
    files: ['src/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: wsBan,
          patterns: [
            {
              group: ['../**'],
              allowTypeImports: true,
              message: 'core imports nothing above itself (spec App. I)',
            },
          ],
        },
      ],
    },
  },
  {
    // A subdirectory *inside* core: `../` is still core, so only `../../` and
    // deeper escape it. Spelling the depth out is the same footgun the header
    // warns about — a wildcard never matches a `..` segment.
    files: ['src/core/*/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: wsBan,
          patterns: [
            {
              group: ['../../**'],
              allowTypeImports: true,
              message: 'core imports nothing above itself (spec App. I)',
            },
          ],
        },
      ],
    },
  },
  {
    // `db` imports only `core` (and itself).
    files: ['src/db/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: wsBan,
          patterns: [
            {
              group: aboveDb.flatMap((m) => [
                `../${m}/**`,
                `../../${m}/**`,
                `../${m}`,
                `../../${m}`,
              ]),
              allowTypeImports: true,
              message: 'db imports only core (spec App. I)',
            },
          ],
        },
      ],
    },
  },
  {
    // Integrations never reach into the network layer.
    files: ['src/tools/integrations/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: wsBan,
          patterns: [
            {
              group: ['../net/**', '../../net/**', '../../../net/**', '../../../../net/**'],
              allowTypeImports: true,
              message: 'integrations never import net (spec App. I)',
            },
          ],
        },
      ],
    },
  },
  {
    // Nothing imports ui/; daemon/ only via the bundled-mode composition point.
    files: ['src/**/*.ts'],
    ignores: ['src/egress/bundled-daemon.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../ui/**',
                '../../ui/**',
                '../../../ui/**',
                '../daemon/**',
                '../../daemon/**',
                '../../../daemon/**',
              ],
              message:
                'nothing imports ui/; daemon/ is imported only by src/egress/bundled-daemon.ts (spec App. I, §7.3)',
            },
          ],
        },
      ],
    },
  },
);
