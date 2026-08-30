import { ROUTABLE_PURPOSES, type Route, type RoutablePurpose } from '../core/config-schemas.js';

export { ROUTABLE_PURPOSES };
export type { RoutablePurpose, Route };

/**
 * Who is asking for a model (§10.6, vocabulary). `probe` shows up in traces
 * (`ModelSelector.purpose`) but is deliberately not in `ROUTABLE_PURPOSES` —
 * it never reads `routes:`, because the probe builds its own one-endpoint
 * router before any routing config exists to read.
 */
export type Purpose = RoutablePurpose | 'probe';

/**
 * The kind-default table §10.6 step 3 describes, now normative rather than
 * folklore. `src/cli/models.ts` prints this table against the live config and
 * `test/cost.test.ts` pins it — there must be no second copy of these lines
 * anywhere. `embedding`, `stt` and `tts` have no class to default to; their
 * fallback is "the first endpoint of that kind" (`ModelRouter.embedding()`,
 * `ModelRouter.speech()`), which a `Route` can't express, so it's `null` here.
 */
export const DEFAULT_ROUTES: Record<RoutablePurpose, Route | null> = {
  chat: { class: 'best' },
  handler: { class: 'fast' },
  ingress: { class: 'fast' },
  distill: { class: 'best' },
  title: { class: 'fast' },
  memory: { class: 'fast' },
  embedding: null,
  stt: null,
  tts: null,
};
