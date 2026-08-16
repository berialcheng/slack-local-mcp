/**
 * Read-only Slack file tools.
 */

import { z } from 'zod';

import type { SlackClient } from '../slack-client.js';
import type {
  DownloadFileInput,
  DownloadFileToolOutput,
  FileInfoToolOutput,
  GetFileInfoInput,
} from '../types.js';
import {
  FILE_DOWNLOAD_POLICY,
  formatSlackFile,
  getDownloadSkipReason,
  normalizeSlackFileId,
} from '../utils/file-download.js';

const fileReferenceSchema = z
  .string()
  .min(1)
  .describe('Slack file ID (for example F012ABCDEF) or a Slack /files/... permalink');

export const getFileInfoTool = {
  name: 'get_file_info',
  description:
    'Get safe metadata for a Slack file by file ID or Slack file permalink. Returns type, size, dimensions, and download eligibility without exposing the private download URL.',
  inputSchema: z.object({
    file: fileReferenceSchema,
  }),
};

export async function handleGetFileInfo(
  input: GetFileInfoInput,
  client: SlackClient,
): Promise<FileInfoToolOutput> {
  const fileId = normalizeSlackFileId(input.file);
  const file = await client.getFileInfo(fileId);
  return {
    file: formatSlackFile(file),
    download_policy: FILE_DOWNLOAD_POLICY,
  };
}

export const downloadFileTool = {
  name: 'download_file',
  description:
    'Download a Slack-hosted file into the OS temp folder. Images strictly smaller than 20 MiB are allowed by default. Videos and other file types are skipped unless explicitly enabled; the 20 MiB hard limit always applies.',
  inputSchema: z.object({
    file: fileReferenceSchema,
    allow_video: z
      .boolean()
      .optional()
      .default(false)
      .describe('Explicitly allow video downloads under 20 MiB (default: false)'),
    allow_other: z
      .boolean()
      .optional()
      .default(false)
      .describe('Explicitly allow non-image, non-video downloads under 20 MiB (default: false)'),
  }),
};

export async function handleDownloadFile(
  input: DownloadFileInput,
  client: SlackClient,
): Promise<DownloadFileToolOutput> {
  const fileId = normalizeSlackFileId(input.file);
  const file = await client.getFileInfo(fileId);
  const formattedFile = formatSlackFile(file);
  const skipReason = getDownloadSkipReason(file, {
    allowVideo: input.allow_video,
    allowOther: input.allow_other,
  });

  if (skipReason) {
    return {
      downloaded: false,
      status: 'skipped',
      file: formattedFile,
      policy: FILE_DOWNLOAD_POLICY,
      reason: skipReason,
    };
  }

  const result = await client.downloadFile(file, {
    allowVideo: input.allow_video,
    allowOther: input.allow_other,
  });
  return {
    downloaded: true,
    status: 'downloaded',
    file: formattedFile,
    policy: FILE_DOWNLOAD_POLICY,
    ...result,
  };
}
