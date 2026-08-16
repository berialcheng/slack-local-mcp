import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LogLevel } from './types.js';
import { ValidationError } from './types.js';

const execFileAsync = promisify(execFile);

export const requiredSlackVariables = ['SLACK_COOKIE_D', 'SLACK_WORKSPACE_URL'] as const;
export const optionalSlackVariables = [
  'LOG_LEVEL',
  'SLACK_RESPONSE_FORMAT',
  'SLACK_USER_CACHE_FILE',
  'SLACK_USER_AGENT',
] as const;

const slackVariables = [...requiredSlackVariables, ...optionalSlackVariables] as const;

export interface SlackRuntimeConfig {
  cookieD: string;
  workspaceUrl: string;
  userAgent?: string;
  logLevel: LogLevel;
  responseFormat: 'toon' | 'json';
  userCacheFile?: string;
}

type Environment = Record<string, string | undefined>;
type UserEnvironmentReader = (signal?: AbortSignal) => Promise<Environment>;
type RequiredSlackEnvironment = Environment &
  Record<(typeof requiredSlackVariables)[number], string>;

function assertRequiredSlackEnvironment(
  values: Environment,
): asserts values is RequiredSlackEnvironment {
  const missing = requiredSlackVariables.filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required Slack configuration: ${missing.join(', ')}. ` +
        'Set the values in the MCP environment or the Windows user environment.',
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseWindowsUserEnvironment(output: string): Environment {
  const values: Environment = {};
  for (const name of slackVariables) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`, 'm');
    const value = output.match(pattern)?.[1]?.trimEnd();
    if (value) {
      values[name] = value;
    }
  }
  return values;
}

export async function readWindowsUserEnvironment(signal?: AbortSignal): Promise<Environment> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const reg = path.join(systemRoot, 'System32', 'reg.exe');

  try {
    const { stdout } = await execFileAsync(reg, ['query', 'HKCU\\Environment'], {
      encoding: 'utf8',
      windowsHide: true,
      signal,
    });
    return parseWindowsUserEnvironment(stdout);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return {};
  }
}

export async function loadSlackRuntimeConfig({
  env = process.env,
  platform = process.platform,
  useWindowsUserEnvironment = env.SLACK_LOAD_WINDOWS_USER_ENV === '1',
  readUserEnvironment = readWindowsUserEnvironment,
  signal,
}: {
  env?: Environment;
  platform?: NodeJS.Platform;
  useWindowsUserEnvironment?: boolean;
  readUserEnvironment?: UserEnvironmentReader;
  signal?: AbortSignal;
} = {}): Promise<SlackRuntimeConfig> {
  const values: Environment = { ...env };
  const hasMissingValue = slackVariables.some((name) => !values[name]);

  if (hasMissingValue && useWindowsUserEnvironment && platform === 'win32') {
    const userValues = await readUserEnvironment(signal);
    for (const name of slackVariables) {
      values[name] ||= userValues[name];
    }
  }

  assertRequiredSlackEnvironment(values);

  const logLevel = values.LOG_LEVEL || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ValidationError(`LOG_LEVEL must be debug, info, warn, or error; got: ${logLevel}`);
  }

  const responseFormat = values.SLACK_RESPONSE_FORMAT || 'toon';
  if (responseFormat !== 'toon' && responseFormat !== 'json') {
    throw new ValidationError(
      `SLACK_RESPONSE_FORMAT must be 'toon' or 'json'; got: ${responseFormat}`,
    );
  }

  return {
    cookieD: values.SLACK_COOKIE_D,
    workspaceUrl: values.SLACK_WORKSPACE_URL,
    userAgent: values.SLACK_USER_AGENT,
    logLevel: logLevel as LogLevel,
    responseFormat,
    userCacheFile: values.SLACK_USER_CACHE_FILE,
  };
}
