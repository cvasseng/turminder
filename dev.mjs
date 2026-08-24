// Dev supervisor: `tsx watch` reloads on change but a crashed process stays
// dead until the next edit, which is exactly when you're staring at a stack
// trace instead of editing. So we own both halves: watch src/ + daemon/ and
// restart on change, and respawn on any exit we didn't ask for — with backoff
// when the process dies straight out of boot, so a broken startup doesn't
// spin. Dev tooling only; the service itself knows nothing about this.
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';

const args = process.argv.slice(2);
const BOOT_GRACE_MS = 2000; // died faster than this = crash loop, back off
const DEBOUNCE_MS = 150;

let child = null;
let restarting = false; // an exit we caused, not a crash
let shuttingDown = false;
let fastCrashes = 0;
let pendingTimer = null; // debounce
let pendingStart = null; // crash-backoff timer

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (msg) => console.log(`\x1b[2m[dev ${stamp()}]\x1b[0m ${msg}`);

function start() {
  // Single-flight, learned the hard way: a crash-backoff timer firing next
  // to a file-change restart once produced four children fighting over one
  // port, the oldest holding it with stale code.
  if (child) return;
  const bootedAt = Date.now();
  // node --import tsx, not npx: wrappers swallow signals and orphan the
  // real process; this way the pid we hold is the service itself.
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) process.exit(code ?? 0);
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    if (code === 0 && Date.now() - bootedAt < 15_000) {
      // One-shot CLI commands (`npm run dev events`) finish cleanly and
      // fast; only abnormal exits are crashes worth supervising. The uptime
      // check matters: the server also exits 0 on graceful SIGTERM, and a
      // long-lived clean exit is someone restarting it — respawn, don't die
      // (learned when a config-reload kill took the supervisor with it).
      say('exited cleanly — done');
      process.exit(0);
    }
    if (code === 0) {
      say('long-lived clean exit (external stop?) — respawning with fresh config');
      pendingStart = setTimeout(() => {
        pendingStart = null;
        start();
      }, 1000);
      return;
    }
    // A crash. Immediate respawn unless it can't survive boot.
    const lived = Date.now() - bootedAt;
    fastCrashes = lived < BOOT_GRACE_MS ? fastCrashes + 1 : 0;
    const delay = Math.min(1000 * 2 ** fastCrashes, 10_000);
    say(`exited (${signal ?? `code ${code}`}) after ${lived}ms — restarting in ${delay}ms`);
    pendingStart = setTimeout(() => {
      pendingStart = null;
      start();
    }, delay);
  });
}

function restart(reason) {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    fastCrashes = 0;
    say(`${reason} — restarting`);
    if (pendingStart) {
      // A crash-backoff wait is superseded by the change that may fix it.
      clearTimeout(pendingStart);
      pendingStart = null;
    }
    if (!child) return start();
    restarting = true;
    child.kill('SIGTERM');
    const stubborn = child;
    // signalCode check: exitCode stays null on signal death; don't shoot corpses.
    setTimeout(
      () =>
        stubborn.exitCode === null && stubborn.signalCode === null && stubborn.kill('SIGKILL'),
      3000,
    ).unref();
  }, DEBOUNCE_MS);
}

chokidar
  .watch(['src', 'daemon'], { ignoreInitial: true, ignored: /node_modules|\.tmp\.\d+\./ })
  .on('all', (event, path) => restart(`${path} ${event}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shuttingDown = true;
    if (child) child.kill('SIGTERM');
    else process.exit(0);
  });
}

start();
