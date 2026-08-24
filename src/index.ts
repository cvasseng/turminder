#!/usr/bin/env node
import { Command } from 'commander';
import { bootstrap } from './app.js';
import { isUserFacing } from './core/errors.js';
import { logger } from './core/logger.js';
import { VERSION } from './core/version.js';
import { registerTokenCommand } from './cli/token.js';
import { registerSecretsCommand } from './cli/secrets.js';
import { registerModelsCommand } from './cli/models.js';
import { registerDoctorCommand } from './cli/doctor.js';
import { registerServeCommand } from './cli/serve.js';
import { registerAskCommand } from './cli/ask.js';
import { registerEventsCommand } from './cli/events.js';
import { registerSetupCommand } from './cli/setup.js';
import { registerOnboardCommand } from './cli/onboard.js';
import { registerIndexCommand } from './cli/index-cmd.js';
import { registerMemoryCommand } from './cli/memory.js';
import { registerHandlersCommand } from './cli/handlers.js';
import { registerSkillsCommand } from './cli/skills.js';
import { registerSchedulesCommand } from './cli/schedules.js';
import { registerDeliveriesCommand } from './cli/deliveries.js';
import { registerAuthCommand } from './cli/auth.js';
import { registerSourcesCommand } from './cli/sources.js';
import { registerToolsCommand } from './cli/tools.js';
import { registerEmbedsCommand } from './cli/embeds.js';

const program = new Command();

program
  .name('turminder')
  .description('A self-hosted, LLM-driven personal assistant')
  .version(VERSION)
  .option('--data-dir <path>', 'data home (default: $TURMINDER_DATA_DIR or ~/.turminder)')
  .option(
    '--bind <host:port>',
    'listen address (default: $TURMINDER_BIND or config/turminder.yaml)',
  )
  .showHelpAfterError();

registerServeCommand(program);
registerDoctorCommand(program);
registerTokenCommand(program);
registerSecretsCommand(program);
registerModelsCommand(program);
registerAskCommand(program);
registerEventsCommand(program);
registerSetupCommand(program);
registerOnboardCommand(program);
registerIndexCommand(program);
registerMemoryCommand(program);
registerHandlersCommand(program);
registerSkillsCommand(program);
registerSchedulesCommand(program);
registerDeliveriesCommand(program);
registerAuthCommand(program);
registerSourcesCommand(program);
registerToolsCommand(program);
registerEmbedsCommand(program);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((e: unknown) => {
  if (isUserFacing(e)) {
    logger.error({ code: e.code }, e.message);
    if (e.detail) logger.error(e.detail);
  } else {
    logger.error({ err: e }, 'fatal');
  }
  process.exitCode = 1;
});

export { bootstrap };
