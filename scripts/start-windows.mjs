import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const requiredVariables = ['SLACK_COOKIE_D', 'SLACK_WORKSPACE_URL'];

export const optionalVariables = [
  'LOG_LEVEL',
  'SLACK_RESPONSE_FORMAT',
  'SLACK_USER_CACHE_FILE',
  'SLACK_USER_AGENT',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseRegistryQuery(output, name) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`, 'm');
  const match = output.match(pattern);
  return match?.[1]?.trimEnd() || undefined;
}

export function readWindowsUserEnvironment(name) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const reg = path.join(systemRoot, 'System32', 'reg.exe');

  try {
    const output = execFileSync(reg, ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegistryQuery(output, name);
  } catch {
    return undefined;
  }
}

export function loadWindowsUserEnvironment({
  env = process.env,
  platform = process.platform,
  readUserEnvironment = readWindowsUserEnvironment,
} = {}) {
  if (platform !== 'win32') {
    throw new Error(
      'The Windows launcher only supports Windows. Start build/index.js directly on other platforms.',
    );
  }

  for (const name of [...requiredVariables, ...optionalVariables]) {
    if (!env[name]) {
      const value = readUserEnvironment(name);
      if (value) {
        env[name] = value;
      }
    }
  }

  const missing = requiredVariables.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required Windows user environment variable(s): ${missing.join(', ')}`);
  }

  return env;
}

async function main() {
  loadWindowsUserEnvironment();

  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const entrypoint = path.resolve(scriptDirectory, '..', 'build', 'index.js');
  if (!existsSync(entrypoint)) {
    throw new Error('Slack Local MCP is not built. Run npm install first.');
  }

  await import(pathToFileURL(entrypoint).href);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const currentPath = fileURLToPath(import.meta.url);

if (invokedPath === currentPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
