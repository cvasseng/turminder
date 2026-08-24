import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { requireModelStack } from '../model/index.js';
import { runAgent } from '../model/agent-loop.js';
import { MemoryTraceSink, type ModelClass, type Priority } from '../model/types.js';
import { assembleSystemPrompt } from '../prompts/index.js';
import { nowIso } from '../core/time.js';
import { UserFacingError } from '../core/errors.js';
import { globalOpts } from './common.js';

interface AskOpts {
  priority: string;
  class: string;
  stream: boolean;
  trace: boolean;
}

/** The phase-1 smoke command: one prompt, through the whole model layer. */
export function registerAskCommand(program: Command): void {
  program
    .command('ask <prompt...>')
    .description('one-shot completion through the router, scheduler and agent loop')
    .option('--priority <p>', 'interactive | event | background', 'interactive')
    .option('--class <c>', 'fast | best', 'fast')
    .option('--no-stream', 'wait for the full completion instead of streaming')
    .option('--trace', 'print the llm_call trace records when done')
    .action(async (promptWords: string[], opts: AskOpts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const priority = opts.priority as Priority;
        if (!['interactive', 'event', 'background'].includes(priority)) {
          throw new UserFacingError(
            'bad_option',
            `--priority must be interactive|event|background`,
          );
        }
        const modelClass = opts.class as ModelClass;
        if (!['fast', 'best'].includes(modelClass)) {
          throw new UserFacingError('bad_option', `--class must be fast|best`);
        }

        const { gateway } = requireModelStack(app.config);
        const trace = new MemoryTraceSink();
        const system = assembleSystemPrompt({
          kind: 'chat',
          identity: app.config.identity(),
          personality: app.config.personality(),
          now: nowIso(),
        });

        const result = await runAgent(gateway, {
          selector: { class: modelClass },
          priority,
          system,
          messages: [{ role: 'user', content: promptWords.join(' ') }],
          trace,
          ...(opts.stream ? { onDelta: (t: string) => process.stdout.write(t) } : {}),
        });

        if (!opts.stream) process.stdout.write(result.text);
        process.stdout.write('\n');

        if (result.stopReason !== 'stop') {
          process.stderr.write(
            `\n[stopped: ${result.stopReason}${result.error ? ` — ${result.error}` : ''}]\n`,
          );
          process.exitCode = 1;
        }
        if (opts.trace) {
          process.stderr.write(
            `\n${JSON.stringify(
              {
                endpoint: result.endpoint,
                turns: result.turns,
                tokens: { in: result.tokensIn, out: result.tokensOut },
                stop: result.stopReason,
                llm_calls: trace.ofKind('llm_call'),
              },
              null,
              2,
            )}\n`,
          );
        }
      } finally {
        app.close();
      }
    });
}
