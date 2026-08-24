import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../core/logger.js';
import type { DataHome } from '../core/datadir.js';
import type { UploadRow, UploadsRepo } from '../db/repos/uploads.js';

const l = log('uploads');

/**
 * v1 accepts images and nothing else (§26.1). Documents belong in `files/`,
 * where `docs.*` can actually work on them; an upload is conversation
 * ephemera, not a workspace artifact.
 */
export const ACCEPTED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type UploadError =
  | { error: 'unsupported_media_type'; message: string }
  | { error: 'too_large'; message: string };

export interface UploadStoreDeps {
  home: DataHome;
  repo: UploadsRepo;
  /** Read per call so editing `uploads.max_mb` takes effect without a restart. */
  maxMb: () => number;
}

/**
 * The attachment store (§26.1): content-addressed bytes under `uploads/`,
 * metadata in the `uploads` table.
 *
 * Content addressing means the same screenshot pasted twice is one file and
 * two rows — the name and the conversation differ, the bytes do not. The
 * directory is gitignored by decree: a screenshot committed to the data repo
 * is permanent bloat that no diff will ever explain.
 */
export class UploadStore {
  constructor(private readonly deps: UploadStoreDeps) {}

  get repo(): UploadsRepo {
    return this.deps.repo;
  }

  /** Absolute path of an upload's bytes. */
  fileFor(row: Pick<UploadRow, 'sha256' | 'mime'>): string {
    const ext = ACCEPTED_MIME[row.mime] ?? 'bin';
    return path.join(this.deps.home.uploadsDir, `${row.sha256}.${ext}`);
  }

  /** True when the bytes are still on disk — a reaped upload leaves no file. */
  exists(row: Pick<UploadRow, 'sha256' | 'mime'>): boolean {
    return fs.existsSync(this.fileFor(row));
  }

  read(row: Pick<UploadRow, 'sha256' | 'mime'>): Buffer | null {
    try {
      return fs.readFileSync(this.fileFor(row));
    } catch {
      return null;
    }
  }

  /**
   * Store bytes. Expected failures are values, not throws: an oversize paste
   * and a PDF dropped on the chat window are both things the user did, not
   * bugs.
   */
  put(input: { data: Buffer; mime: string; name: string }): UploadRow | UploadError {
    const mime = input.mime.split(';')[0]!.trim().toLowerCase();
    const ext = ACCEPTED_MIME[mime];
    if (!ext) {
      return {
        error: 'unsupported_media_type',
        message: `chat attachments are images only (${Object.keys(ACCEPTED_MIME).join(', ')}); put documents in the workspace instead`,
      };
    }
    const maxBytes = this.deps.maxMb() * 1024 * 1024;
    if (input.data.length > maxBytes) {
      return {
        error: 'too_large',
        message: `that image is ${(input.data.length / 1024 / 1024).toFixed(1)}MB; the limit is ${this.deps.maxMb()}MB`,
      };
    }
    const sha256 = crypto.createHash('sha256').update(input.data).digest('hex');
    const row = this.deps.repo.create({
      sha256,
      name: sanitiseName(input.name) || `image.${ext}`,
      mime,
      bytes: input.data.length,
    });
    const file = this.fileFor(row);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Content-addressed: identical bytes are already the same file.
    if (!fs.existsSync(file)) fs.writeFileSync(file, input.data);
    l.debug({ upload: row.id, bytes: row.bytes, mime }, 'upload stored');
    return row;
  }

  /**
   * Everything one conversation claimed, gone with it (§26.1). An attachment is
   * ephemera of the transcript that claimed it — unlike an embed, it has no life
   * after one — and its foreign key would refuse the delete regardless.
   */
  destroyForConversation(conversationId: string): number {
    const rows = this.deps.repo.forConversation(conversationId);
    for (const row of rows) this.destroy(row);
    return rows.length;
  }

  /** Delete a row, and its bytes when nothing else points at them. */
  destroy(row: UploadRow): void {
    this.deps.repo.remove(row.id);
    if (this.deps.repo.sharesContent(row.sha256, row.id)) return;
    try {
      fs.rmSync(this.fileFor(row), { force: true });
    } catch (e) {
      l.warn({ upload: row.id, err: String(e) }, 'upload file could not be removed');
    }
  }
}

/**
 * A name is a label in a transcript, never a path: strip directories and
 * control characters so a filename cannot pretend to be anything else.
 */
function sanitiseName(name: string): string {
  // Character codes rather than a regex: a control-character class is exactly
  // what eslint's no-control-regex exists to stop, and this reads plainer.
  const printable = [...path.basename(name)].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return printable.join('').slice(0, 120).trim();
}
