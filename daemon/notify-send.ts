import { spawn } from 'node:child_process';
import type { DeliveryFrame, RenderOutcome, Renderer } from './lib.js';

/**
 * Linux rendering via `notify-send` (§7.3). Action buttons use `--action`,
 * which prints the clicked id on stdout and blocks until the notification is
 * dismissed — exactly the shape the daemon library wants.
 */
export class NotifySendRenderer implements Renderer {
  constructor(
    private readonly opts: {
      appName?: string;
      command?: string;
      log?: (m: string) => void;
    } = {},
  ) {}

  private missingNotifierReported = false;

  async show(delivery: DeliveryFrame): Promise<RenderOutcome> {
    const title = String(delivery.payload.title ?? 'Turminder');
    const body = String(delivery.payload.body ?? '');
    const actions = (delivery.payload.actions ?? []) as { id: string; label: string }[];
    const args = [
      '--app-name',
      this.opts.appName ?? 'Turminder',
      '--urgency',
      delivery.intent === 'confirm' ? 'critical' : 'normal',
      // A notification that outlives its usefulness is noise.
      '--expire-time',
      String(Math.max(5_000, Math.min(120_000, msUntil(delivery.expires_at)))),
    ];
    for (const action of actions) args.push('--action', `${action.id}=${action.label}`);
    args.push(title, body);

    const command = this.opts.command ?? 'notify-send';
    return new Promise<RenderOutcome>((resolve) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let stderr = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (stderr += String(d)));
      child.on('error', (e) => {
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        if (missing && !this.missingNotifierReported) {
          this.missingNotifierReported = true;
          this.opts.log?.(
            `cannot show notifications: "${command}" is not on PATH. ` +
              'Install a notifier (Debian/Ubuntu: libnotify-bin, Arch/Nix: libnotify, ' +
              'Fedora: libnotify) or set daemon.notify_command to one you have.',
          );
        } else if (!missing) {
          this.opts.log?.(`${command} failed: ${e.message}`);
        }
        resolve({ shown: false, reason: e.message });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          this.opts.log?.(`${command} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
          resolve({ shown: false, reason: `exit ${code}` });
          return;
        }
        const clicked = out.trim();
        resolve({
          shown: true,
          action: actions.some((a) => a.id === clicked) ? clicked : null,
        });
      });
    });
  }
}

function msUntil(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 30_000 : Math.max(0, t - Date.now());
}
