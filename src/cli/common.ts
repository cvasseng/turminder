import type { Command } from 'commander';

export interface GlobalOpts {
  dataDir?: string;
  bind?: string;
}

/** Reads the global flags from wherever they were given (program or subcommand). */
export function globalOpts(cmd: Command): GlobalOpts {
  const o = cmd.optsWithGlobals<{ dataDir?: string; bind?: string }>();
  return {
    ...(o.dataDir ? { dataDir: o.dataDir } : {}),
    ...(o.bind ? { bind: o.bind } : {}),
  };
}
