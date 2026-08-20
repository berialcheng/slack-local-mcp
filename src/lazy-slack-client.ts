import type { SlackClient } from './slack-client.js';
import { AuthenticationError, TimeoutError } from './types.js';

export type SlackClientFactory = (signal: AbortSignal) => Promise<SlackClient>;

interface InitializationState {
  controller: AbortController;
  promise: Promise<SlackClient>;
  timeout: NodeJS.Timeout;
  waiters: number;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : abortError('Operation cancelled');
  }
}

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : abortError('Operation cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Creates and authenticates the Slack client only when a tool first needs it.
 * Concurrent first callers share one initialization attempt. A caller can stop
 * waiting independently; the shared attempt is cancelled only when no callers
 * remain. Authentication failures invalidate the cached client and are retried
 * exactly once with a freshly fetched Slack token.
 */
export class LazySlackClientProvider {
  private client: SlackClient | undefined;
  private initialization: InitializationState | undefined;

  constructor(
    private readonly createClient: SlackClientFactory,
    private readonly initializationTimeoutMs: number = 45_000,
  ) {}

  async getClient(signal?: AbortSignal): Promise<SlackClient> {
    throwIfAborted(signal);
    if (this.client) {
      return this.client;
    }

    const state = this.initialization ?? this.startInitialization();
    state.waiters += 1;

    try {
      return await waitForPromise(state.promise, signal);
    } finally {
      state.waiters -= 1;
      if (state.waiters === 0 && this.initialization === state && !this.client) {
        state.controller.abort(abortError('Slack initialization has no active callers'));
      }
    }
  }

  async run<T>(action: (client: SlackClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await this.getClient(signal);
      try {
        return await client.withRequestSignal(signal, () => action(client));
      } catch (error) {
        if (!(error instanceof AuthenticationError)) {
          throw error;
        }
        if (this.client === client) {
          this.client = undefined;
        }
        if (attempt > 0) {
          throw error;
        }
      }
    }
    throw new AuthenticationError('Slack reauthentication failed');
  }

  private startInitialization(): InitializationState {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new TimeoutError(`Slack initialization exceeded ${this.initializationTimeoutMs}ms`),
      );
    }, this.initializationTimeoutMs);
    timeout.unref();
    const state: InitializationState = {
      controller,
      promise: this.initializeClient(controller.signal),
      timeout,
      waiters: 0,
    };
    this.initialization = state;

    void state.promise
      .finally(() => {
        clearTimeout(state.timeout);
        if (this.initialization === state) {
          this.initialization = undefined;
        }
      })
      .catch(() => undefined);

    return state;
  }

  private async initializeClient(signal: AbortSignal): Promise<SlackClient> {
    const client = await waitForPromise(this.createClient(signal), signal);
    await waitForPromise(client.authenticate(signal), signal);
    throwIfAborted(signal);
    this.client = client;
    return client;
  }
}
