import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';

export interface UploadRow {
  id: string;
  sha256: string;
  name: string;
  mime: string;
  bytes: number;
  conversation_id: string | null;
  created_at: string;
}

export interface NewUpload {
  sha256: string;
  name: string;
  mime: string;
  bytes: number;
}

/**
 * Chat attachments (§26.1, App. C). The row is the addressable half; the bytes
 * are a content-addressed file in `uploads/`. Two uploads of the same image
 * share the file and keep separate rows, because the name and the conversation
 * are per-upload facts.
 */
export class UploadsRepo {
  constructor(private readonly db: Db) {}

  create(input: NewUpload): UploadRow {
    const row: UploadRow = {
      id: newId(),
      ...input,
      conversation_id: null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO uploads (id, sha256, name, mime, bytes, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.sha256, row.name, row.mime, row.bytes, null, row.created_at);
    return row;
  }

  get(id: string): UploadRow | null {
    return (this.db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(id) as UploadRow) ?? null;
  }

  /** Resolve a batch in one go, for a `chat.send` carrying several. */
  many(ids: readonly string[]): UploadRow[] {
    if (!ids.length) return [];
    const holes = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM uploads WHERE id IN (${holes})`)
      .all(...ids) as UploadRow[];
  }

  /** Claim uploads for the conversation that first referenced them (§26.1). */
  attachTo(conversationId: string, ids: readonly string[]): void {
    if (!ids.length) return;
    const claim = this.db.prepare(
      `UPDATE uploads SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL`,
    );
    for (const id of ids) claim.run(conversationId, id);
  }

  /** Everything one conversation claimed — what deleting it has to take along. */
  forConversation(conversationId: string): UploadRow[] {
    return this.db
      .prepare(`SELECT * FROM uploads WHERE conversation_id = ? ORDER BY created_at ASC`)
      .all(conversationId) as UploadRow[];
  }

  /** Rows past their TTL — what the reaper deletes, row and file together. */
  reapable(cutoff: string): UploadRow[] {
    return this.db
      .prepare(`SELECT * FROM uploads WHERE created_at < ? ORDER BY created_at ASC`)
      .all(cutoff) as UploadRow[];
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM uploads WHERE id = ?`).run(id);
  }

  /** Is this content still referenced by any row? Content addressing shares files. */
  sharesContent(sha256: string, exceptId: string): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM uploads WHERE sha256 = ? AND id != ?`)
      .get(sha256, exceptId) as { n: number };
    return row.n > 0;
  }
}
