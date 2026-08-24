import pino, { type Logger } from 'pino';

const pretty =
  Boolean(process.stderr.isTTY) && !process.env.VITEST && !process.env.TURMINDER_LOG_JSON;

/**
 * Logs go to **stderr**, always. stdout belongs to command output — mixing the
 * two makes `turminder events show --json | jq` a lottery.
 */
export const logger: Logger = pretty
  ? pino({
      level: process.env.TURMINDER_LOG_LEVEL ?? 'info',
      base: undefined,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          destination: 2,
        },
      },
    })
  : pino(
      { level: process.env.TURMINDER_LOG_LEVEL ?? 'info', base: undefined },
      pino.destination(2),
    );

/** Component-scoped child logger: `log('db')`. */
export function log(component: string): Logger {
  return logger.child({ c: component });
}
