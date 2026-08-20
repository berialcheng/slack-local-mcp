import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';

import type {
  FileDownloadPolicy,
  FormattedSlackFile,
  SlackFile,
  SlackFileCategory,
} from '../types.js';
import { ValidationError } from '../types.js';

export const MAX_FILE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const COMPLETED_DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PART_DOWNLOAD_RETENTION_MS = 60 * 60 * 1000;
export const DOWNLOAD_DIRECTORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const FILE_DOWNLOAD_POLICY: FileDownloadPolicy = {
  max_bytes_exclusive: MAX_FILE_DOWNLOAD_BYTES,
  max_size: '20 MiB (exclusive)',
  default_images: true,
  default_videos: false,
  default_other_files: false,
};

export interface FileDownloadOptions {
  allowVideo?: boolean;
  allowOther?: boolean;
}

const FILE_ID_PATTERN = /^F[A-Z0-9]{8,}$/i;

function isValidFileSize(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0;
}

export function normalizeSlackFileId(input: string): string {
  const value = input.trim();
  if (FILE_ID_PATTERN.test(value)) {
    return value.toUpperCase();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('File must be a Slack file ID or Slack file permalink');
  }

  if (url.protocol !== 'https:' || !isAllowedSlackHostname(url.hostname)) {
    throw new ValidationError('Only HTTPS Slack file permalinks are accepted');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const filesIndex = segments.findIndex((segment) => segment.toLowerCase() === 'files');
  const candidate = filesIndex >= 0 ? segments[filesIndex + 2] : undefined;
  if (!candidate || !FILE_ID_PATTERN.test(candidate)) {
    throw new ValidationError('Could not extract a Slack file ID from the permalink');
  }

  return candidate.toUpperCase();
}

export function classifySlackFile(mimetype?: string): SlackFileCategory {
  const normalized = (mimetype || '').trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  return 'other';
}

export function formatSlackFile(file: SlackFile): FormattedSlackFile {
  const category = classifySlackFile(file.mimetype);
  const privateUrl = file.url_private_download || file.url_private;
  let downloadAvailable = false;
  if (privateUrl && !file.is_external && file.mode !== 'external') {
    try {
      assertAllowedSlackDownloadUrl(privateUrl);
      downloadAvailable = true;
    } catch {
      downloadAvailable = false;
    }
  }
  return {
    id: file.id,
    name: file.name || file.title || file.id,
    title: file.title || file.name || file.id,
    mimetype: file.mimetype || 'application/octet-stream',
    filetype: file.filetype || '',
    size: isValidFileSize(file.size) ? file.size : null,
    mode: file.mode || '',
    category,
    permalink: file.permalink,
    original_w: file.original_w,
    original_h: file.original_h,
    alt_text: file.alt_txt,
    download_available: downloadAvailable,
    download_eligible_by_default:
      category === 'image' &&
      isValidFileSize(file.size) &&
      file.size < MAX_FILE_DOWNLOAD_BYTES &&
      downloadAvailable,
  };
}

export function getDownloadSkipReason(
  file: SlackFile,
  options: FileDownloadOptions = {},
): string | undefined {
  if (!isValidFileSize(file.size)) {
    return 'Slack did not provide a valid file size, so the download was skipped.';
  }
  if (file.size >= MAX_FILE_DOWNLOAD_BYTES) {
    return `File is ${file.size} bytes; downloads require a size strictly below ${MAX_FILE_DOWNLOAD_BYTES} bytes (20 MiB).`;
  }
  if (file.is_external || file.mode === 'external') {
    return 'External or remote files are metadata-only and are not downloaded.';
  }
  if (!file.url_private_download && !file.url_private) {
    return 'Slack did not provide a private download URL for this file.';
  }

  const category = classifySlackFile(file.mimetype);
  return getFileCategorySkipReason(category, options);
}

export function getFileCategorySkipReason(
  category: SlackFileCategory,
  options: FileDownloadOptions = {},
): string | undefined {
  if (category === 'video' && !options.allowVideo) {
    return 'Video downloads are disabled by default. Set allow_video=true to opt in.';
  }
  if (category === 'other' && !options.allowOther) {
    return 'Non-image downloads are disabled by default. Set allow_other=true to opt in.';
  }
  return undefined;
}

export function isAllowedSlackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'slack.com' || normalized.endsWith('.slack.com');
}

export function assertAllowedSlackDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('Slack returned an invalid download URL');
  }

  if (url.protocol !== 'https:' || !isAllowedSlackHostname(url.hostname)) {
    throw new ValidationError('Slack download URL must use HTTPS on a Slack-owned host');
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new ValidationError('Slack download URL contains unsupported credentials or port');
  }
  return url;
}

export function sanitizeDownloadFilename(value: string, fallback: string): string {
  const sanitizeComponent = (component: string): string => {
    const base = path.basename(component);
    return Array.from(base, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || '<>:"/\\|?*'.includes(character) ? '_' : character;
    })
      .join('')
      .replace(/[. ]+$/g, '')
      .slice(0, 180);
  };

  return sanitizeComponent(value) || sanitizeComponent(fallback) || 'slack-file';
}

/**
 * Best-effort cleanup scoped strictly to files generated by this MCP. Completed
 * downloads remain available for seven days; abandoned partial files for one hour.
 */
export async function cleanupSlackDownloadDirectory(
  directory: string,
  now: number = Date.now(),
): Promise<number> {
  let entries;
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^F[A-Z0-9]{8,}-/i.test(entry.name)) continue;
    const isPartial = entry.name.endsWith('.part');
    const retention = isPartial ? PART_DOWNLOAD_RETENTION_MS : COMPLETED_DOWNLOAD_RETENTION_MS;
    const candidate = path.join(directory, entry.name);
    try {
      const stats = await fsPromises.lstat(candidate);
      if (!stats.isFile() || now - stats.mtimeMs <= retention) continue;
      await fsPromises.unlink(candidate);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}
