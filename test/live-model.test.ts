import { describe, expect, it } from 'vitest';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ModelRouter } from '../src/model/router.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import { runAgent } from '../src/model/agent-loop.js';
import { MemoryTraceSink, type LlmCallTrace } from '../src/model/types.js';
import type { DispatchCall, DispatchResult, ToolDispatcher } from '../src/model/dispatcher.js';

/**
 * The model-vetting harness from the phase-1 risk item: point it at a real
 * llama.cpp instance and find out what that model can actually be trusted with.
 *
 *   TURMINDER_LIVE_ENDPOINT=http://127.0.0.1:8080/v1 npx vitest run test/live-model.test.ts
 */
const endpoint = process.env.TURMINDER_LIVE_ENDPOINT;
const model = process.env.TURMINDER_LIVE_MODEL ?? 'default';
const suite = endpoint ? describe : describe.skip;

function gateway(): ModelGateway {
  const router = new ModelRouter(
    ModelsYamlSchema.parse({
      endpoints: [
        {
          name: 'live',
          url: endpoint!,
          model,
          classes: ['fast', 'best'],
          caps: ['json', 'tools'],
        },
      ],
    }),
  );
  return new ModelGateway(router, new InferenceScheduler(1));
}

class OneToolDispatcher implements ToolDispatcher {
  readonly calls: DispatchCall[] = [];
  toolSet(): ToolSet {
    return {
      get_time: tool({
        description: 'Get the current time in a given IANA timezone.',
        inputSchema: jsonSchema<{ timezone: string }>({
          type: 'object',
          properties: { timezone: { type: 'string', description: 'IANA timezone' } },
          required: ['timezone'],
          additionalProperties: false,
        }),
      }),
    };
  }
  async dispatch(call: DispatchCall): Promise<DispatchResult> {
    this.calls.push(call);
    return { ok: true, output: { time: '2026-08-20T21:00:00.000Z', timezone: 'Europe/Oslo' } };
  }
}

suite('live llama.cpp endpoint', () => {
  it('streams a completion through the scheduler', { timeout: 120_000 }, async () => {
    const trace = new MemoryTraceSink();
    const deltas: string[] = [];
    const r = await runAgent(gateway(), {
      selector: { class: 'fast' },
      priority: 'interactive',
      system: 'Answer in one short sentence. No preamble.',
      messages: [{ role: 'user', content: 'What is the capital of Norway?' }],
      trace,
      onDelta: (t) => deltas.push(t),
      budgets: { timeoutS: 90 },
    });
    expect(r.stopReason).toBe('stop');
    expect(r.text.toLowerCase()).toContain('oslo');
    expect(deltas.length).toBeGreaterThan(1);
    const rec = trace.ofKind('llm_call')[0] as LlmCallTrace;
    expect(rec.tokens_out).toBeGreaterThan(0);
    console.log('live text:', JSON.stringify(r.text.slice(0, 200)), rec);
  });

  it('does a tool-call round trip through the agent loop', { timeout: 180_000 }, async () => {
    const disp = new OneToolDispatcher();
    const trace = new MemoryTraceSink();
    const r = await runAgent(gateway(), {
      selector: { caps: ['tools'] },
      priority: 'interactive',
      system:
        'You have tools. When the user asks for the current time you MUST call get_time. Never guess the time.',
      messages: [{ role: 'user', content: 'What time is it in Oslo right now?' }],
      dispatcher: disp,
      trace,
      budgets: { maxTurns: 4, timeoutS: 150 },
    });
    console.log(
      'tool calls:',
      JSON.stringify(disp.calls),
      'stop:',
      r.stopReason,
      r.text.slice(0, 200),
    );
    expect(disp.calls.length).toBeGreaterThanOrEqual(1);
    expect(disp.calls[0]?.name).toBe('get_time');
    expect(r.stopReason).toBe('stop');
  });

  it('returns schema-constrained JSON', { timeout: 120_000 }, async () => {
    const r = await gateway().turn({
      selector: { caps: ['json'] },
      priority: 'interactive',
      system: 'Classify the message. Return only JSON.',
      messages: [
        { role: 'user', content: 'The invoice for August is attached, due next Friday.' },
      ],
      jsonSchema: {
        name: 'classification',
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            is_invoice: { type: 'boolean' },
          },
          required: ['summary', 'is_invoice'],
          additionalProperties: false,
        },
      },
    });
    console.log('json text:', r.text);
    const parsed = JSON.parse(r.text) as { summary: string; is_invoice: boolean };
    expect(typeof parsed.summary).toBe('string');
    expect(parsed.is_invoice).toBe(true);
  });
});
