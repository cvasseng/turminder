import { jsonSchema, tool, type ToolSet } from 'ai';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ModelRouter } from '../src/model/router.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import type { DispatchCall, DispatchResult, ToolDispatcher } from '../src/model/dispatcher.js';

export function gatewayFor(baseUrl: string, opts: { concurrency?: number } = {}): ModelGateway {
  const router = new ModelRouter(
    ModelsYamlSchema.parse({
      endpoints: [
        {
          name: 'fake',
          url: baseUrl,
          classes: ['fast', 'best'],
          caps: ['json', 'tools'],
          ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
        },
      ],
    }),
  );
  return new ModelGateway(router, new InferenceScheduler(1));
}

/** A dispatcher that records calls and answers from a canned map. */
export class RecordingDispatcher implements ToolDispatcher {
  readonly calls: DispatchCall[] = [];
  constructor(
    private readonly tools: Record<string, (args: any) => unknown | Promise<unknown>>,
    private readonly opts: {
      throwOn?: string;
      /** Per-tool bulk-content fields (§20.6), reported like the real dispatcher does. */
      bulkArgs?: Record<string, readonly string[]>;
      /** Per-tool JSON schema; the default is the one-field `{q}` shape. */
      schema?: Record<string, Record<string, unknown>>;
    } = {},
  ) {}

  toolSet(): ToolSet {
    const set: ToolSet = {};
    for (const name of Object.keys(this.tools)) {
      set[name] = tool({
        description: `test tool ${name}`,
        inputSchema: jsonSchema<any>(
          this.opts.schema?.[name] ?? {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
            additionalProperties: false,
          },
        ),
      });
    }
    return set;
  }

  async dispatch(call: DispatchCall): Promise<DispatchResult> {
    this.calls.push(call);
    if (this.opts.throwOn === call.name) throw new Error('dispatcher exploded');
    const impl = this.tools[call.name];
    if (!impl) return { ok: false, output: { error: 'unknown_tool' }, denied: 'not_granted' };
    const bulk = this.opts.bulkArgs?.[call.name];
    return { ok: true, output: await impl(call.args), ...(bulk ? { bulkArgs: bulk } : {}) };
  }
}
