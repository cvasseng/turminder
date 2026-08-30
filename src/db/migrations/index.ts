import type { Migration } from './types.js';
import { migration as m001 } from './001-init.js';
import { migration as m002 } from './002-conversation-distilled-at.js';
import { migration as m003 } from './003-conversation-open-namespaces.js';
import { migration as m004 } from './004-embeds.js';
import { migration as m005 } from './005-embed-bindings.js';
import { migration as m006 } from './006-uploads.js';
import { migration as m007 } from './007-watchers.js';
import { migration as m008 } from './008-conversation-model-override.js';
import { migration as m009 } from './009-conversation-effort-override.js';
import { migration as m010 } from './010-conversation-loaded-projects.js';
import { migration as m011 } from './011-schedule-on-miss.js';
import { migration as m012 } from './012-trace-kind-at.js';
import { migration as m013 } from './013-conversation-voice-device.js';

/** Numbered migrations, applied in order. Add new ones here; never edit old ones. */
export const MIGRATIONS: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
];

export const DB_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export type { Migration };
