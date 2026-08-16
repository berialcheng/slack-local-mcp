import assert from 'node:assert/strict';
import test from 'node:test';

import { LazySlackClientProvider } from '../build/lazy-slack-client.js';
import { AuthenticationError } from '../build/types.js';

function runnable(client) {
  return {
    ...client,
    async withRequestSignal(_signal, action) {
      return action();
    },
  };
}

test('does not create or authenticate a Slack client until first use', async () => {
  let created = 0;
  let authenticated = 0;
  const client = {
    async authenticate() {
      authenticated += 1;
    },
  };
  const provider = new LazySlackClientProvider(async () => {
    created += 1;
    return client;
  });

  assert.equal(created, 0);
  assert.equal(authenticated, 0);

  assert.equal(await provider.getClient(), client);
  assert.equal(created, 1);
  assert.equal(authenticated, 1);

  assert.equal(await provider.getClient(), client);
  assert.equal(created, 1);
  assert.equal(authenticated, 1);
});

test('shares one initialization attempt between concurrent first callers', async () => {
  let created = 0;
  let authenticated = 0;
  let releaseAuthentication;
  const authenticationGate = new Promise((resolve) => {
    releaseAuthentication = resolve;
  });
  const client = {
    async authenticate() {
      authenticated += 1;
      await authenticationGate;
    },
  };
  const provider = new LazySlackClientProvider(async () => {
    created += 1;
    return client;
  });

  const first = provider.getClient();
  const second = provider.getClient();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created, 1);
  assert.equal(authenticated, 1);
  releaseAuthentication();

  const [firstClient, secondClient] = await Promise.all([first, second]);
  assert.equal(firstClient, client);
  assert.equal(secondClient, client);
});

test('releases a failed initialization so a later call can retry', async () => {
  let created = 0;
  const recoveredClient = { async authenticate() {} };
  const provider = new LazySlackClientProvider(async () => {
    created += 1;
    if (created === 1) {
      return {
        async authenticate() {
          throw new Error('temporary authentication failure');
        },
      };
    }
    return recoveredClient;
  });

  await assert.rejects(provider.getClient(), /temporary authentication failure/);
  assert.equal(await provider.getClient(), recoveredClient);
  assert.equal(created, 2);
});

test('invalidates an expired client and retries the operation once after reauthentication', async () => {
  let created = 0;
  const firstClient = runnable({ async authenticate() {} });
  const recoveredClient = runnable({ async authenticate() {} });
  const provider = new LazySlackClientProvider(async () => {
    created += 1;
    return created === 1 ? firstClient : recoveredClient;
  });

  const result = await provider.run(async (client) => {
    if (client === firstClient) throw new AuthenticationError('token expired');
    return 'recovered';
  });

  assert.equal(result, 'recovered');
  assert.equal(created, 2);
});

test('coalesces concurrent expired-token recovery into one replacement client', async () => {
  let created = 0;
  const expiredClient = runnable({ async authenticate() {} });
  const recoveredClient = runnable({ async authenticate() {} });
  const provider = new LazySlackClientProvider(async () => {
    created += 1;
    return created === 1 ? expiredClient : recoveredClient;
  });
  await provider.getClient();

  const action = async (client) => {
    if (client === expiredClient) throw new AuthenticationError('token expired');
    return 'ok';
  };
  assert.deepEqual(await Promise.all([provider.run(action), provider.run(action)]), ['ok', 'ok']);
  assert.equal(created, 2);
});

test('does not retain a replacement client that also reports expired authentication', async () => {
  let created = 0;
  const provider = new LazySlackClientProvider(async () => {
    created += 1;
    return runnable({ async authenticate() {} });
  });

  await assert.rejects(
    provider.run(async () => {
      throw new AuthenticationError('still expired');
    }),
    /still expired/,
  );
  await provider.getClient();
  assert.equal(created, 3);
});

test('keeps shared initialization alive while at least one caller is still waiting', async () => {
  let releaseAuthentication;
  let initializationSignal;
  const gate = new Promise((resolve) => {
    releaseAuthentication = resolve;
  });
  const client = {
    async authenticate(signal) {
      initializationSignal = signal;
      await gate;
    },
  };
  const provider = new LazySlackClientProvider(async () => client);
  const cancelledCaller = new AbortController();
  const first = provider.getClient(cancelledCaller.signal);
  const second = provider.getClient();
  await new Promise((resolve) => setImmediate(resolve));

  cancelledCaller.abort();
  await assert.rejects(first, /abort/i);
  assert.equal(initializationSignal.aborted, false);
  releaseAuthentication();
  assert.equal(await second, client);
});

test('cancels a hanging initialization when its bounded timeout expires', async () => {
  let internalSignal;
  const client = {
    async authenticate(signal) {
      internalSignal = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const provider = new LazySlackClientProvider(async () => client, 20);

  await assert.rejects(provider.getClient(), /exceeded 20ms/);
  assert.equal(internalSignal.aborted, true);
});
