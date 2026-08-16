import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  if (process.platform !== 'win32') {
    throw new Error(
      'The Windows launcher only supports Windows. Start build/index.js directly on other platforms.',
    );
  }

  // The core service resolves HKCU environment values on the first tool call.
  // Merely starting/listing this MCP therefore creates no registry or network child work.
  process.env.SLACK_LOAD_WINDOWS_USER_ENV = '1';

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
