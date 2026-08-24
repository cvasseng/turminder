import type { Db } from '../index.js';
import { ConversationsRepo } from './conversations.js';
import { DeliveriesRepo } from './deliveries.js';
import { EmbedsRepo } from './embeds.js';
import { EventsRepo } from './events.js';
import { MetaRepo } from './meta.js';
import { RunsRepo } from './runs.js';
import { SchedulesRepo } from './schedules.js';
import { TraceRepo } from './trace.js';
import { UploadsRepo } from './uploads.js';
import { WatchersRepo } from './watchers.js';

export interface Repos {
  events: EventsRepo;
  deliveries: DeliveriesRepo;
  embeds: EmbedsRepo;
  meta: MetaRepo;
  conversations: ConversationsRepo;
  runs: RunsRepo;
  schedules: SchedulesRepo;
  trace: TraceRepo;
  uploads: UploadsRepo;
  watchers: WatchersRepo;
}

export function createRepos(db: Db): Repos {
  return {
    events: new EventsRepo(db),
    deliveries: new DeliveriesRepo(db),
    embeds: new EmbedsRepo(db),
    meta: new MetaRepo(db),
    conversations: new ConversationsRepo(db),
    runs: new RunsRepo(db),
    schedules: new SchedulesRepo(db),
    trace: new TraceRepo(db),
    uploads: new UploadsRepo(db),
    watchers: new WatchersRepo(db),
  };
}

export {
  ConversationsRepo,
  DeliveriesRepo,
  EmbedsRepo,
  EventsRepo,
  MetaRepo,
  RunsRepo,
  SchedulesRepo,
  TraceRepo,
  UploadsRepo,
  WatchersRepo,
};
export type { EventRecord, EventStatus, NewEventInput } from './events.js';
export type { RunRow, NewRun, FinishRun } from './runs.js';
export type { ScheduleRow, ScheduleStatus, NewSchedule } from './schedules.js';
export type { Delivery, DeliveryIntent, DeliveryStatus, NewDelivery } from './deliveries.js';
export type { TraceEntry } from './trace.js';
export type { EmbedKind, EmbedRow } from './embeds.js';
export type {
  ConversationMode,
  ConversationRow,
  ConversationStatus,
  Turn,
} from './conversations.js';
