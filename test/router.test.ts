import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/model/router.js';
import { UserFacingError } from '../src/core/errors.js';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';

function router(yaml: unknown) {
  return new ModelRouter(ModelsYamlSchema.parse(yaml));
}

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

describe('ModelRouter', () => {
  it('routes by class', () => {
    const r = router(twoEndpoints);
    expect(r.pick({ class: 'fast' }).name).toBe('quick');
    expect(r.pick({ class: 'best' }).name).toBe('big');
  });

  it('filters on required capabilities', () => {
    const r = router(twoEndpoints);
    expect(r.pick({ caps: ['tools'] }).name).toBe('big');
    expect(r.pick({ class: 'best', caps: ['long_context'] }).name).toBe('big');
  });

  it('explains itself when nothing qualifies', () => {
    const r = router(twoEndpoints);
    try {
      r.pick({ class: 'fast', caps: ['tools'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UserFacingError);
      expect((e as UserFacingError).code).toBe('no_endpoint');
      expect((e as UserFacingError).message).toContain('class=fast');
      expect((e as UserFacingError).detail).toContain('quick');
    }
  });

  it('honours an explicit endpoint and still checks caps', () => {
    const r = router(twoEndpoints);
    expect(r.pick({ endpoint: 'quick' }).name).toBe('quick');
    expect(() => r.pick({ endpoint: 'quick', caps: ['tools'] })).toThrowError(/capability/);
    expect(() => r.pick({ endpoint: 'ghost' })).toThrowError(/no endpoint named/);
  });

  it('normalises urls, defaults, and rejects duplicate names', () => {
    const r = router(twoEndpoints);
    expect(r.pick({ class: 'fast' }).url).toBe('http://localhost:8080/v1');
    expect(r.pick({ class: 'fast' }).concurrency).toBe(1);
    expect(r.pick({ class: 'best' }).concurrency).toBe(2);
    expect(() =>
      router({
        endpoints: [
          { name: 'x', url: 'http://a/v1', classes: ['fast'] },
          { name: 'x', url: 'http://b/v1', classes: ['best'] },
        ],
      }),
    ).toThrowError(/duplicate endpoint/);
  });

  it('exposes the embedding endpoint when configured', () => {
    const r = router({ ...twoEndpoints, embedding: { url: 'http://localhost:8080/' } });
    expect(r.embedding()).toEqual({ url: 'http://localhost:8080', model: 'default' });
    expect(router(twoEndpoints).embedding()).toBeNull();
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
    expect(r.pick({ class: 'fast' }).name).toBe('quick');
    expect(r.pick({ class: 'best' }).name).toBe('big');
  });

  it('treats a single endpoint classed both ways as fast and best (setup default)', () => {
    const r = router({
      endpoints: [
        { name: 'main', url: 'http://x/v1', classes: ['fast', 'best'], caps: ['json'] },
      ],
    });
    expect(r.pick({ class: 'fast' }).name).toBe('main');
    expect(r.pick({ class: 'best' }).name).toBe('main');
  });
});
