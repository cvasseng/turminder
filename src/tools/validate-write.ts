import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import type { z } from 'zod';
import {
  HandlerFrontmatterSchema,
  IdentitySchema,
  PersonalitySchema,
  SkillFrontmatterSchema,
  TurminderYamlSchema,
} from '../core/config-schemas.js';

export interface WriteRejection {
  ok: false;
  error: 'invalid_content';
  message: string;
  detail: string;
}

export type WriteCheck = { ok: true } | WriteRejection;

function issues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

function reject(message: string, detail: string): WriteRejection {
  return { ok: false, error: 'invalid_content', message, detail };
}

/**
 * Checks a file *before* it is written, for the kinds we know how to load.
 *
 * Without this, `config.write` happily commits a document the loader will
 * refuse, the caller is told `committed: true`, and the only sign of trouble is
 * a warning in a log nobody is reading. An agent that cannot see its mistake
 * cannot correct it, so the mistake belongs in the tool result.
 *
 * Unknown paths are not validated: this is a safety net for the shapes we
 * define, not a gate on everything a user might keep in their data dir.
 */
export function validateWrite(relPath: string, content: string): WriteCheck {
  const normalised = relPath.split(path.sep).join('/');
  const [root, ...rest] = normalised.split('/');
  const file = rest.join('/');

  if (root === 'skills' && file.endsWith('.md')) {
    return checkMarkdown(normalised, content, SkillFrontmatterSchema, {
      example:
        '---\nname: firmafakta\ndescription: When and how to look up Norwegian company data.\n---\n\nThe guidance itself…',
      expectedName: path.basename(file, '.md'),
      needsBody: true,
    });
  }

  if (root === 'handlers' && file.endsWith('.md')) {
    return checkMarkdown(normalised, content, HandlerFrontmatterSchema, {
      example:
        '---\nname: invoice-arrival\ndescription: Use for email containing an invoice.\ntools: [memory.save]\n---\n\nInstructions to yourself…',
      expectedName: path.basename(file, '.md'),
      needsBody: true,
    });
  }

  if (normalised === 'config/identity.md') {
    return checkMarkdown(normalised, content, IdentitySchema, {
      example:
        '---\ninstance_name: Sleeper Service\nuser_name: Alex\ntimezone: Europe/Oslo\nlocale: en\n---\n',
      needsBody: false,
    });
  }

  if (normalised === 'config/personality.md') {
    return checkMarkdown(normalised, content, PersonalitySchema, {
      example:
        '---\nformality: relaxed\nverbosity: terse\nhumor: dry\n---\n\nHow to come across…',
      needsBody: false,
    });
  }

  if (normalised === 'config/turminder.yaml') {
    return checkYaml(normalised, content, TurminderYamlSchema);
  }

  return { ok: true };
}

interface MarkdownRules {
  example: string;
  expectedName?: string;
  needsBody: boolean;
}

function checkMarkdown(
  label: string,
  content: string,
  schema: z.ZodTypeAny,
  rules: MarkdownRules,
): WriteCheck {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (e) {
    return reject(
      `${label}: the YAML frontmatter is malformed`,
      `${(e as Error).message}. It should look like:\n\n${rules.example}`,
    );
  }

  const hasFrontmatter = Object.keys(parsed.data ?? {}).length > 0;
  if (!hasFrontmatter) {
    return reject(
      `${label}: no YAML frontmatter — the file needs a --- block before the prose`,
      `Every ${label.split('/')[0]} file starts with frontmatter. It should look like:\n\n${rules.example}`,
    );
  }

  const result = schema.safeParse(parsed.data);
  if (!result.success) {
    return reject(
      `${label}: frontmatter is not valid`,
      `${issues(result.error)}\n\nExpected:\n\n${rules.example}`,
    );
  }

  const named = (parsed.data as { name?: string }).name;
  if (rules.expectedName && named && named !== rules.expectedName) {
    return reject(
      `${label}: name "${named}" must match the filename "${rules.expectedName}"`,
      `Either rename the file to ${rules.expectedName === named ? named : `${named}.md`} or change the name field to "${rules.expectedName}".`,
    );
  }

  if (rules.needsBody && !parsed.content.trim()) {
    return reject(
      `${label}: the body is empty — frontmatter alone says nothing`,
      'Put the actual guidance or instructions after the closing --- line.',
    );
  }

  return { ok: true };
}

function checkYaml(label: string, content: string, schema: z.ZodTypeAny): WriteCheck {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (e) {
    return reject(`${label}: not valid YAML`, (e as Error).message);
  }
  const result = schema.safeParse(parsed ?? {});
  if (!result.success) {
    return reject(`${label}: not a valid configuration`, issues(result.error));
  }
  return { ok: true };
}
