import type { Config } from '../core/config.js';
import { UserFacingError } from '../core/errors.js';
import { ModelGateway, type GatewayOptions } from './gateway.js';
import { ModelRouter } from './router.js';
import { InferenceScheduler } from './scheduler.js';

export interface ModelStack {
  router: ModelRouter;
  scheduler: InferenceScheduler;
  gateway: ModelGateway;
}

/** null when models.yaml is absent or invalid — the setup trigger (plan §3b). */
export function createModelStack(config: Config, opts: GatewayOptions = {}): ModelStack | null {
  const { models } = config.modelsOrNull();
  if (!models) return null;
  const router = new ModelRouter(models);
  const scheduler = new InferenceScheduler(config.settings.backgroundConcurrency);
  return { router, scheduler, gateway: new ModelGateway(router, scheduler, opts) };
}

export function requireModelStack(config: Config, opts: GatewayOptions = {}): ModelStack {
  const stack = createModelStack(config, opts);
  if (!stack) {
    const { error } = config.modelsOrNull();
    throw new UserFacingError(
      'models_unconfigured',
      error
        ? `config/models.yaml is not usable: ${error}`
        : 'no models configured — open the web UI to run setup, or write config/models.yaml',
    );
  }
  return stack;
}

export { ModelGateway } from './gateway.js';
export { ModelRouter } from './router.js';
export { InferenceScheduler } from './scheduler.js';
export { runAgent, DEFAULT_BUDGETS } from './agent-loop.js';
export { emptyDispatcher } from './dispatcher.js';
export type { AgentRunRequest, AgentRunResult, StopReason } from './agent-loop.js';
export type { DispatchCall, DispatchResult, ToolDispatcher } from './dispatcher.js';
export type { TurnRequest, TurnResult, RawToolCall, JsonSchemaSpec } from './gateway.js';
export * from './types.js';
