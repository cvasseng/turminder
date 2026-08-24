#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { Daemon } from './lib.js';
import { NotifySendRenderer } from './notify-send.js';
import { WsDaemonTransport } from './ws-transport.js';

/**
 * The desktop daemon: connect, render notifications, send clicks back. It holds
 * no state beyond a delivery cursor, and has no execute capability (§14.3).
 */
const program = new Command();

program
  .name('turminder-daemon')
  .description('render Turminder notifications on this desktop')
  .requiredOption('--url <url>', 'service base url, e.g. http://turminder.tailnet:7787')
  .requiredOption('--token <token>', 'device token — ask the assistant to connect this machine')
  .option('--device <name>', 'device name reported to the service', os.hostname())
  .option('--state <path>', 'where to keep the delivery cursor', defaultStatePath())
  .option('--notify-command <cmd>', 'notifier binary', 'notify-send')
  .action(async (opts: Record<string, string>) => {
    const statePath = opts.state!;
    const lastSeen = readCursor(statePath);
    const log = (message: string, data?: unknown) => {
      process.stderr.write(
        `${new Date().toISOString()} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`,
      );
    };

    const transport = new WsDaemonTransport({ url: opts.url!, token: opts.token!, log });
    const daemon = new Daemon(transport, {
      device: opts.device!,
      capabilities: ['notify.actions'],
      renderer: new NotifySendRenderer({ command: opts.notifyCommand, log: (m) => log(m) }),
      lastSeen,
      onLastSeen: (seq) => writeCursor(statePath, seq),
      log,
    });
    // Re-greet after every reconnect so the server replays what we missed.
    transport.onReconnect(() => daemon.greet());
    // A notifier that dies when the network hiccups is worse than useless:
    // the transport retries on its own, so log and stay up.
    process.on('unhandledRejection', (reason) => log('unhandled rejection', String(reason)));
    try {
      await daemon.start();
    } catch (e) {
      log('initial connection failed; will keep retrying', (e as Error).message);
    }
    log('daemon running', { device: opts.device, last_seen: lastSeen });

    await new Promise<void>((resolve) => {
      const stop = () => void daemon.stop().then(resolve);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });

function defaultStatePath(): string {
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'turminder', 'daemon.json');
}

function readCursor(file: string): number {
  try {
    return Number(
      (JSON.parse(fs.readFileSync(file, 'utf8')) as { last_seen?: number }).last_seen ?? 0,
    );
  } catch {
    return 0;
  }
}

function writeCursor(file: string, seq: number): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ last_seen: seq }), 'utf8');
  } catch {
    /* a lost cursor only means a replay */
  }
}

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
});
