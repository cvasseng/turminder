import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/model/router.js';
import { UserFacingError } from '../src/core/errors.js';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { DEFAULT_ROUTES, ROUTABLE_PURPOSES } from '../src/model/routes.js';
import type { ModelClass } from '../src/core/config-schemas.js';

function router(yaml: unknown) {
  return new ModelRouter(ModelsYamlSchema.parse(yaml));
}

function parses(yaml: unknown): boolean {
  return ModelsYamlSchema.safeParse(yaml).success;
}

/** A frontmatter-style class pin, for exercising `matchClass` without a
 *  configured route — the purpose is arbitrary here, only the class matters. */
const pinClass = (cls: ModelClass) => ({
  purpose: 'chat' as const,
  pin: { class: cls, by: 'frontmatter' as const },
});

const twoEndpoints = {
  endpoints: [
    { name: 'quick', url: 'http://localhost:8080/v1/', classes: ['fast'], caps: ['json'] },
    {
      name: 'big',
      url: 'http://localhost:8081/v1',
      classes: ['best'],
      caps: ['json', 'tools', 'long_context'],
      context_size: 65536,
      concurrency: 2,
    },
  ],
};

describe('ModelRouter.resolve — class/caps filtering (unchanged from pick())', () => {
  it('routes by class', () => {
    const r = router(twoEndpoints);
    expect(r.resolve(pinClass('fast')).endpoint.name).toBe('quick');
    expect(r.resolve(pinClass('best')).endpoint.name).toBe('big');
  });

  it('filters on required capabilities', () => {
    const r = router(twoEndpoints);
    expect(r.resolve({ purpose: 'chat', caps: ['tools'] }).endpoint.name).toBe('big');
    expect(r.resolve({ ...pinClass('best'), caps: ['long_context'] }).endpoint.name).toBe(
      'big',
    );
  });

  it('explains itself when nothing qualifies', () => {
    const r = router(twoEndpoints);
    try {
      r.resolve({ ...pinClass('fast'), caps: ['tools'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UserFacingError);
      expect((e as UserFacingError).code).toBe('no_endpoint');
      expect((e as UserFacingError).message).toContain('class=fast');
      expect((e as UserFacingError).detail).toContain('quick');
    }
  });

  it('honours an explicit endpoint pin and still checks caps', () => {
    const r = router(twoEndpoints);
    expect(
      r.resolve({ purpose: 'chat', pin: { endpoint: 'quick', by: 'override' } }).endpoint.name,
    ).toBe('quick');
    expect(() =>
      r.resolve({
        purpose: 'chat',
        pin: { endpoint: 'quick', by: 'override' },
        caps: ['tools'],
      }),
    ).toThrowError(/capability/);
    expect(() =>
      r.resolve({ purpose: 'chat', pin: { endpoint: 'ghost', by: 'override' } }),
    ).toThrowError(/no chat endpoint named/);
  });

  it('normalises urls, defaults, and rejects duplicate names', () => {
    const r = router(twoEndpoints);
    expect(r.resolve(pinClass('fast')).endpoint.url).toBe('http://localhost:8080/v1');
    expect(r.resolve(pinClass('fast')).endpoint.concurrency).toBe(1);
    expect(r.resolve(pinClass('best')).endpoint.concurrency).toBe(2);
    expect(() =>
      router({
        endpoints: [
          { name: 'x', url: 'http://a/v1', classes: ['fast'] },
          { name: 'x', url: 'http://b/v1', classes: ['best'] },
        ],
      }),
    ).toThrowError(/duplicate endpoint/);
  });

  it('sends a fast request to a fast endpoint when one exists (§30.5)', () => {
    // The `watch-changed` handler asks for `fast` precisely so the big model
    // never wakes to say "your parcel moved". If class requests were advisory
    // that whole design would be decoration.
    const r = router({
      endpoints: [
        { name: 'quick', url: 'http://localhost:8080/v1', classes: ['fast'], caps: [] },
        { name: 'big', url: 'http://localhost:8081/v1', classes: ['best'], caps: [] },
      ],
    });
    expect(r.resolve(pinClass('fast')).endpoint.name).toBe('quick');
    expect(r.resolve(pinClass('best')).endpoint.name).toBe('big');
  });

  it('treats a single endpoint classed both ways as fast and best (setup default)', () => {
    const r = router({
      endpoints: [
        { name: 'main', url: 'http://x/v1', classes: ['fast', 'best'], caps: ['json'] },
      ],
    });
    expect(r.resolve(pinClass('fast')).endpoint.name).toBe('main');
    expect(r.resolve(pinClass('best')).endpoint.name).toBe('main');
  });
});

describe('ModelRouter — kinds (§10.6 v2)', () => {
  it('exposes the embedding endpoint when configured, by name or by default', () => {
    const withRoute = router({
      ...twoEndpoints,
      endpoints: [
        ...twoEndpoints.endpoints,
        { name: 'emb', url: 'http://localhost:8080/', kind: 'embedding' },
      ],
      routes: { embedding: { endpoint: 'emb' } },
    });
    expect(withRoute.embedding()).toMatchObject({ name: 'emb', kind: 'embedding' });

    const withoutRoute = router({
      ...twoEndpoints,
      endpoints: [
        ...twoEndpoints.endpoints,
        { name: 'emb', url: 'http://localhost:8080/', kind: 'embedding' },
      ],
    });
    // No `routes.embedding` — falls back to the first `kind: embedding` endpoint.
    expect(withoutRoute.embedding()?.name).toBe('emb');

    // Never throws, and reports null rather than guessing.
    expect(router(twoEndpoints).embedding()).toBeNull();
  });

  it('chatEndpoints() excludes kind: embedding', () => {
    const r = router({
      ...twoEndpoints,
      endpoints: [
        ...twoEndpoints.endpoints,
        { name: 'emb', url: 'http://localhost:8080/', kind: 'embedding' },
      ],
    });
    expect(r.chatEndpoints().map((e) => e.name)).toEqual(['quick', 'big']);
    expect(r.list().map((e) => e.name)).toEqual(['quick', 'big', 'emb']);
  });
});

describe('ModelRouter.resolve — the §10.6 order (M2)', () => {
  const FOUR = {
    endpoints: [
      { name: 'quick', url: 'http://a/v1', classes: ['fast'], caps: ['json', 'tools'] },
      { name: 'big', url: 'http://b/v1', classes: ['best'], caps: ['json', 'tools'] },
      { name: 'blind', url: 'http://c/v1', classes: ['fast', 'best'], caps: [] },
      { name: 'emb', url: 'http://d', kind: 'embedding' },
    ],
  };

  it('override beats frontmatter beats route beats default', () => {
    const r = router({ ...FOUR, routes: { handler: { class: 'best' } } });
    // Kind default first (no route for `chat`, no pin).
    expect(r.resolve({ purpose: 'chat' })).toMatchObject({
      resolved_by: 'kind_default',
      endpoint: { name: 'big' },
    });
    // A configured route for `handler` beats the kind default (fast).
    expect(r.resolve({ purpose: 'handler' })).toMatchObject({
      resolved_by: 'route',
      endpoint: { name: 'big' },
      requested_class: 'best',
    });
    // A frontmatter pin beats the route.
    expect(
      r.resolve({ purpose: 'handler', pin: { endpoint: 'quick', by: 'frontmatter' } }),
    ).toMatchObject({ resolved_by: 'frontmatter', endpoint: { name: 'quick' } });
    // A selector carries one pin at a time (§10.6 steps 1–2 are mutually
    // exclusive by construction); this shows step 1 is checked before step 2
    // ever runs — an `override` pin resolves exactly like one, unconditionally.
    expect(
      r.resolve({ purpose: 'handler', pin: { endpoint: 'blind', by: 'override' } }),
    ).toMatchObject({ resolved_by: 'override', endpoint: { name: 'blind' } });
  });

  it('route vs kind_default is observable', () => {
    const withRoute = router({ ...FOUR, routes: { title: { class: 'best' } } });
    expect(withRoute.resolve({ purpose: 'title' }).resolved_by).toBe('route');
    const withoutRoute = router(FOUR);
    expect(withoutRoute.resolve({ purpose: 'title' }).resolved_by).toBe('kind_default');
  });

  it('a {endpoint} route to a non-chat endpoint is refused', () => {
    const r = router({ ...FOUR, routes: { chat: { endpoint: 'emb' } } });
    expect(() => r.resolve({ purpose: 'chat' })).toThrowError(/no chat endpoint named "emb"/);
  });

  it('probe never routes and always uses the first endpoint', () => {
    const r = router(FOUR);
    expect(r.resolve({ purpose: 'probe' })).toMatchObject({
      resolved_by: 'kind_default',
      endpoint: { name: 'quick' },
    });
  });

  it('DEFAULT_ROUTES has an entry for every routable purpose', () => {
    for (const purpose of ROUTABLE_PURPOSES) expect(DEFAULT_ROUTES).toHaveProperty(purpose);
    expect(DEFAULT_ROUTES.embedding).toBeNull();
  });
});

describe('ModelsYamlSchema — kind and routes (M1)', () => {
  it('defaults an endpoint with no kind to chat', () => {
    const parsed = ModelsYamlSchema.parse({
      endpoints: [{ name: 'main', url: 'http://x/v1', classes: ['fast'] }],
    });
    expect(parsed.endpoints[0]!.kind).toBe('chat');
  });

  it('rejects an embedding endpoint that declares classes', () => {
    expect(
      parses({
        endpoints: [{ name: 'emb', url: 'http://x', kind: 'embedding', classes: ['fast'] }],
      }),
    ).toBe(false);
  });

  it('rejects an embedding endpoint that declares caps/efforts/cost', () => {
    expect(
      parses({
        endpoints: [{ name: 'emb', url: 'http://x', kind: 'embedding', caps: ['json'] }],
      }),
    ).toBe(false);
    expect(
      parses({
        endpoints: [{ name: 'emb', url: 'http://x', kind: 'embedding', efforts: ['low'] }],
      }),
    ).toBe(false);
    expect(
      parses({
        endpoints: [
          {
            name: 'emb',
            url: 'http://x',
            kind: 'embedding',
            cost: { in_per_mtok: 1, out_per_mtok: 1, currency: 'USD' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts a bare kind: embedding endpoint', () => {
    expect(parses({ endpoints: [{ name: 'emb', url: 'http://x', kind: 'embedding' }] })).toBe(
      true,
    );
  });

  it('rejects a chat endpoint with no classes', () => {
    expect(parses({ endpoints: [{ name: 'main', url: 'http://x/v1' }] })).toBe(false);
    expect(parses({ endpoints: [{ name: 'main', url: 'http://x/v1', kind: 'chat' }] })).toBe(
      false,
    );
  });

  it('rejects a routes block with an unknown key', () => {
    expect(
      parses({
        endpoints: [{ name: 'main', url: 'http://x/v1', classes: ['fast'] }],
        routes: { chat: { class: 'best' }, bogus: { class: 'fast' } },
      }),
    ).toBe(false);
  });

  it('rejects routes.embedding shaped as a class route', () => {
    expect(
      parses({
        endpoints: [{ name: 'main', url: 'http://x/v1', classes: ['fast'] }],
        routes: { embedding: { class: 'fast' } },
      }),
    ).toBe(false);
  });

  it('accepts a full routes block', () => {
    const parsed = ModelsYamlSchema.parse({
      endpoints: [
        { name: 'main', url: 'http://x/v1', classes: ['fast', 'best'] },
        { name: 'emb', url: 'http://y', kind: 'embedding' },
      ],
      routes: {
        chat: { class: 'best' },
        handler: { endpoint: 'main' },
        embedding: { endpoint: 'emb' },
      },
    });
    expect(parsed.routes?.handler).toEqual({ endpoint: 'main' });
  });
});

describe('speech endpoints (§10.9, V1.1–1.2)', () => {
  const SPEECH = {
    endpoints: [
      { name: 'main', url: 'http://a/v1', classes: ['fast', 'best'] },
      { name: 'whisper', url: 'http://b/v1', kind: 'stt', model: 'large-v3', language: 'nb' },
      { name: 'whisper-2', url: 'http://c/v1', kind: 'stt', model: 'small' },
      { name: 'piper', url: 'http://d/v1', kind: 'tts', model: 'tts-1', voice: 'alloy' },
    ],
  };

  it('answers null when no endpoint of the kind is configured', () => {
    const r = router({ endpoints: [{ name: 'main', url: 'http://a/v1', classes: ['fast'] }] });
    expect(r.speech('stt')).toBeNull();
    expect(r.speech('tts')).toBeNull();
  });

  it('takes the first endpoint of the kind, in config order', () => {
    const r = router(SPEECH);
    expect(r.speech('stt')?.name).toBe('whisper');
    expect(r.speech('tts')?.name).toBe('piper');
    expect(r.resolveSpeech('stt')?.resolved_by).toBe('kind_default');
  });

  it('prefers a configured route and says the route decided', () => {
    const r = router({ ...SPEECH, routes: { stt: { endpoint: 'whisper-2' } } });
    expect(r.speech('stt')?.name).toBe('whisper-2');
    expect(r.resolveSpeech('stt')?.resolved_by).toBe('route');
  });

  it('refuses a route that names an endpoint of the wrong kind', () => {
    const r = router({ ...SPEECH, routes: { stt: { endpoint: 'piper' } } });
    expect(() => r.speech('stt')).toThrow(UserFacingError);
    try {
      r.speech('stt');
    } catch (e) {
      expect((e as UserFacingError).code).toBe('config_invalid');
      expect((e as UserFacingError).message).toContain('kind: tts');
    }
  });

  it('carries voice, language and the per-kind price onto the resolved endpoint', () => {
    const r = router({
      endpoints: [
        {
          name: 'whisper',
          url: 'http://b/v1/',
          kind: 'stt',
          language: 'nb',
          cost: { per_minute: 0.006, currency: 'USD' },
        },
        {
          name: 'piper',
          url: 'http://d/v1',
          kind: 'tts',
          voice: 'nova',
          cost: { per_kchar: 0.015, currency: 'USD' },
        },
      ],
    });
    expect(r.speech('stt')).toMatchObject({
      language: 'nb',
      url: 'http://b/v1',
      cost: { perMinute: 0.006, currency: 'USD' },
    });
    expect(r.speech('tts')).toMatchObject({
      voice: 'nova',
      cost: { perKchar: 0.015, currency: 'USD' },
    });
  });

  it('keeps speech endpoints out of every chat surface', () => {
    const r = router(SPEECH);
    expect(r.chatEndpoints().map((e) => e.name)).toEqual(['main']);
    expect(r.resolve({ purpose: 'chat' }).endpoint.name).toBe('main');
    expect(() =>
      r.resolve({ purpose: 'chat', pin: { endpoint: 'piper', by: 'override' } }),
    ).toThrow(UserFacingError);
  });

  it('refuses classes, caps and efforts on a speech endpoint', () => {
    const base = { name: 'w', url: 'http://b/v1', kind: 'stt' };
    expect(parses({ endpoints: [{ ...base, classes: ['fast'] }] })).toBe(false);
    expect(parses({ endpoints: [{ ...base, caps: ['json'] }] })).toBe(false);
    expect(parses({ endpoints: [{ ...base, efforts: ['low'] }] })).toBe(false);
    expect(parses({ endpoints: [base] })).toBe(true);
  });

  it('pins voice to tts and language to stt', () => {
    expect(
      parses({ endpoints: [{ name: 'w', url: 'http://b/v1', kind: 'stt', voice: 'alloy' }] }),
    ).toBe(false);
    expect(
      parses({ endpoints: [{ name: 'p', url: 'http://d/v1', kind: 'tts', language: 'nb' }] }),
    ).toBe(false);
    expect(
      parses({
        endpoints: [{ name: 'm', url: 'http://a/v1', classes: ['fast'], voice: 'alloy' }],
      }),
    ).toBe(false);
  });

  it('prices each kind in its own unit and refuses the wrong shape', () => {
    const stt = (cost: unknown) => ({
      endpoints: [{ name: 'w', url: 'http://b/v1', kind: 'stt', cost }],
    });
    expect(parses(stt({ per_minute: 0.006, currency: 'USD' }))).toBe(true);
    expect(parses(stt({ per_kchar: 0.006, currency: 'USD' }))).toBe(false);
    expect(parses(stt({ in_per_mtok: 3, out_per_mtok: 15, currency: 'USD' }))).toBe(false);

    const chat = ModelsYamlSchema.safeParse({
      endpoints: [
        {
          name: 'm',
          url: 'http://a/v1',
          classes: ['fast'],
          cost: { per_minute: 1, currency: 'USD' },
        },
      ],
    });
    expect(chat.success).toBe(false);
    expect(JSON.stringify(chat.error?.issues)).toContain('in_per_mtok');
  });

  it('accepts routes.stt/tts as {endpoint} only', () => {
    expect(parses({ ...SPEECH, routes: { stt: { endpoint: 'whisper' } } })).toBe(true);
    expect(parses({ ...SPEECH, routes: { tts: { class: 'fast' } } })).toBe(false);
  });
});
