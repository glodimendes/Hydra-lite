import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestListener } from '@hono/node-server';
import type { StreamEvent } from '@hydra/web-contracts';
import WebSocket from 'ws';
import { createGatewayApp, type GatewayApp } from '../../index.ts';
import { FakeClock } from '../../shared/clock.ts';
import { GatewayError } from '../../shared/errors.ts';
import type { StreamEventPayload } from '../event-forwarder.ts';
import { MAX_INBOUND_MESSAGE_BYTES } from '../ws-message-handler.ts';

const ORIGIN = 'http://127.0.0.1:4174';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForCloseOrError(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once('close', () => {
      resolve();
    });
    ws.once('error', () => {
      resolve();
    });
  });
}

function parseWsMessage(data: WebSocket.RawData): Record<string, unknown> {
  let payload: Buffer | Uint8Array | string;
  if (typeof data === 'string') {
    payload = data;
  } else if (Array.isArray(data)) {
    payload = Buffer.concat(data);
  } else if (data instanceof ArrayBuffer) {
    payload = new Uint8Array(data);
  } else {
    payload = data;
  }

  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  return JSON.parse(text) as Record<string, unknown>;
}

async function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  const [data] = (await once(ws, 'message')) as [WebSocket.RawData];
  return parseWsMessage(data);
}

/**
 * Consume messages from `ws` until one matches `predicate`, discarding any
 * others along the way. Several connections in this suite also receive an
 * asynchronous bootstrap message (`session-active`, `session-expiring-
 * soon`, or `daemon-restored`) whose exact arrival time relative to a
 * test's own trigger is a genuine race — not a test-environment timing
 * issue, but a real ordering race in the production code between that
 * bootstrap send and whatever the test does next (confirmed by reading
 * session-ws-bridge.ts). Filtering past anything that isn't the message
 * under test is the correct fix, not a longer wait.
 */
async function waitForMessageMatching(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for a matching websocket message'));
    }, timeoutMs);

    function onMessage(data: WebSocket.RawData) {
      const message = parseWsMessage(data);
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    }

    ws.on('message', onMessage);
  });
}

/** Poll `read()` until it stops changing for `quietMs` consecutive
 * milliseconds (an async promise chain has settled), rather than guessing a
 * fixed grace period that may be too short under system load or longer
 * than necessary otherwise. */
async function waitForStable<T>(read: () => T, quietMs: number, timeoutMs = 5000): Promise<T> {
  const startedAt = Date.now();
  let lastValue = read();
  let lastChangedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    const value = read();
    if (value !== lastValue) {
      lastValue = value;
      lastChangedAt = Date.now();
    } else if (Date.now() - lastChangedAt >= quietMs) {
      return lastValue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return lastValue;
    }
  }
}

class FakeEventBridge {
  readonly #listeners = new Set<(payload: StreamEventPayload) => void>();

  on(_eventName: 'stream-event', listener: (payload: StreamEventPayload) => void): this {
    this.#listeners.add(listener);
    return this;
  }

  removeListener(
    _eventName: 'stream-event',
    listener: (payload: StreamEventPayload) => void,
  ): this {
    this.#listeners.delete(listener);
    return this;
  }

  emitStreamEvent(conversationId: string, event: StreamEvent): void {
    const payload: StreamEventPayload = { conversationId, event };
    for (const listener of this.#listeners) {
      listener(payload);
    }
  }
}

function makeStreamEvent(seq: number): StreamEvent {
  return {
    seq,
    turnId: `turn-${seq}`,
    kind: 'text-delta',
    payload: { text: `chunk-${seq}` },
    timestamp: new Date().toISOString(),
  };
}

function createWsDaemonClient(validConversationIds: ReadonlySet<string>) {
  return {
    async openConversation(conversationId: string) {
      if (validConversationIds.has(conversationId)) {
        return {
          data: {
            conversation: {
              id: conversationId,
              status: 'active' as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              turnCount: 0,
              pendingInstructionCount: 0,
            },
            recentTurns: [],
            totalTurnCount: 0,
            pendingApprovals: [],
          },
        };
      }
      return {
        error: {
          ok: false as const,
          code: 'CONVERSATION_NOT_FOUND',
          category: 'validation' as const,
          message: 'Conversation not found',
        },
      };
    },
    async loadTurnHistory() {
      return { data: { turns: [], totalCount: 0, hasMore: false } };
    },
    async getStreamReplay() {
      return { data: { events: [] } };
    },
  };
}

async function waitForMessages(
  ws: WebSocket,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (data: WebSocket.RawData) => {
      messages.push(parseWsMessage(data));
      if (messages.length === count) {
        ws.off('message', onMessage);
        resolve(messages);
      }
    };

    ws.on('message', onMessage);
  });
}

/** Session-bootstrap message types sent asynchronously on connect/recovery
 * (session-ws-bridge.ts's #emitActiveBootstrap/#emitExpiringSoonBootstrap),
 * independent of whatever a test does next — their exact arrival time
 * relative to a test's own trigger is a genuine production-code race, not
 * a test-environment timing issue. */
const BOOTSTRAP_MESSAGE_TYPES = new Set(['session-active', 'daemon-restored']);

/**
 * Like waitForMessages, but silently drops any bootstrap-type message
 * (see BOOTSTRAP_MESSAGE_TYPES) instead of letting it occupy one of the
 * `count` slots — a test asserting on an exact small batch of messages
 * (e.g. two 'subscribed' acks + one 'stream-event') must not have one of
 * those slots stolen by an unrelated bootstrap send it never asked about.
 */
async function waitForMessagesIgnoringBootstrap(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(
        new Error(
          `Timed out waiting for ${String(count)} messages; received ${String(messages.length)}`,
        ),
      );
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const message = parseWsMessage(data);
      if (BOOTSTRAP_MESSAGE_TYPES.has(message['type'] as string)) {
        return;
      }
      messages.push(message);
      if (messages.length === count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(messages);
      }
    };

    ws.on('message', onMessage);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function connectWebSocket(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): Promise<WebSocket> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
  await once(ws, 'open');
  return ws;
}

function createWebSocket(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): WebSocket {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  return new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
}

async function expectUnexpectedResponse(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): Promise<number> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
  const [, response] = (await once(ws, 'unexpected-response')) as [
    unknown,
    { statusCode?: number },
  ];
  return response.statusCode ?? 0;
}

async function expectUnexpectedResponseBody(
  port: number,
  options: {
    path?: string;
    origin?: string;
    sessionId?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    Origin: options.origin ?? ORIGIN,
  };
  if (options.sessionId != null) {
    headers['Cookie'] = `__session=${options.sessionId}`;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers });
  const [, response] = (await once(ws, 'unexpected-response')) as [
    unknown,
    NodeJS.ReadableStream & { statusCode?: number },
  ];

  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });
  await once(response, 'end');

  return {
    status: response.statusCode ?? 0,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

describe('GatewayWsServer', () => {
  let server: Server;
  let gw: GatewayApp;
  let port: number;
  let clock: FakeClock;
  let healthResult: boolean;
  let streamEventBridge: FakeEventBridge;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    clock = new FakeClock(Date.now());
    healthResult = true;
    streamEventBridge = new FakeEventBridge();

    gw = createGatewayApp({
      server,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => healthResult,
      wsDaemonClient: createWsDaemonClient(new Set(['conv-1', 'conv-2'])),
      streamEventBridge,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 60_000,
        warningThresholdMs: 10_000,
        maxExtensions: 3,
        extensionDurationMs: 60_000,
        idleTimeoutMs: 30_000,
      },
    });

    const requestListener = getRequestListener(gw.app.fetch);
    server.on('request', (request, response) => {
      void requestListener(request, response);
    });
    port = await listen(server);
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
      socket.close();
    }
    gw.wsServer?.close();
    gw.heartbeat.stop();
    await closeServer(server);
  });

  it('accepts a valid session and registers the connection', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 1);
  });

  it('handles subscribe messages over websocket and updates conversation subscriptions', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));

    const message = await waitForMessageMatching(ws, (m) => m['type'] === 'subscribed');
    assert.equal(message['type'], 'subscribed');
    assert.equal(message['conversationId'], 'conv-1');
    assert.equal(message['currentSeq'], 0);
    assert.equal(gw.connectionRegistry.getByConversation('conv-1').size, 1);
  });

  it('configures the websocket server hard max payload above the inbound message limit', () => {
    const maxPayload = gw.wsServer?.webSocketServer.options.maxPayload;
    assert.ok(
      typeof maxPayload === 'number' && maxPayload > MAX_INBOUND_MESSAGE_BYTES,
      'maxPayload should be a hard ceiling above the app-level inbound message limit',
    );
  });

  it('returns a structured error without closing for frames larger than the inbound message limit', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);
    ws.on('error', () => {});

    ws.send('x'.repeat(MAX_INBOUND_MESSAGE_BYTES + 1));

    const msg = await waitForMessageMatching(ws, (m) => m['type'] === 'error');
    assert.equal(msg['type'], 'error');
    assert.equal(msg['ok'], false);
    assert.equal(msg['code'], 'WS_INVALID_MESSAGE');
    assert.equal(msg['category'], 'validation');
    assert.ok(
      typeof msg['message'] === 'string' && msg['message'].includes('size'),
      'error message should mention size',
    );
    assert.equal(ws.readyState, WebSocket.OPEN, 'connection should remain open');
  });

  it('serializes subscribe then unsubscribe so stale subscribe completion does not leave the connection subscribed', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async () => pendingOpen.promise,
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
      ws.send(JSON.stringify({ type: 'unsubscribe', conversationId: 'conv-1' }));

      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });

      const messages = await waitForMessagesIgnoringBootstrap(ws, 2);
      assert.deepEqual(
        messages.map((message) => message['type']),
        ['subscribed', 'unsubscribed'],
      );
      assert.equal(localGateway.connectionRegistry.getByConversation('conv-1').size, 0);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('does not replay buffered events twice for duplicate subscribe frames on the same connection', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async () => pendingOpen.promise,
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    localGateway.eventBuffer.push('conv-1', makeStreamEvent(1));
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      const subscribe = JSON.stringify({
        type: 'subscribe',
        conversationId: 'conv-1',
        lastAcknowledgedSeq: 0,
      });
      ws.send(subscribe);
      ws.send(subscribe);

      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });

      const messages = await waitForMessagesIgnoringBootstrap(ws, 3);
      assert.equal(messages.filter((message) => message['type'] === 'stream-event').length, 1);
      assert.equal(messages.filter((message) => message['type'] === 'subscribed').length, 2);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('closes connections that exceed the inbound websocket message queue limit', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    let openCalls = 0;
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async () => {
          openCalls += 1;
          return await pendingOpen.promise;
        },
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      for (let index = 0; index < 65; index += 1) {
        ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
      }

      const message = await waitForMessageMatching(ws, (m) => m['type'] === 'error');
      assert.equal(message['code'], 'WS_MESSAGE_QUEUE_OVERFLOW');
      assert.equal(message['category'], 'rate-limit');
      await waitForCloseOrError(ws);
      assert.ok(openCalls <= 1, `Expected at most 1 openConversation call, got ${openCalls}`);
    } finally {
      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-1',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('does not make daemon calls for queued messages after overflow close', async () => {
    const localServer = createServer();
    const pendingOpen =
      createDeferred<
        Awaited<ReturnType<ReturnType<typeof createWsDaemonClient>['openConversation']>>
      >();
    let openCalls = 0;
    const localGateway = createGatewayApp({
      server: localServer,
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      wsDaemonClient: {
        openConversation: async (conversationId: string) => {
          openCalls += 1;
          const result = await pendingOpen.promise;
          if ('error' in result) {
            return result;
          }
          // Return matching conversation id regardless of which subscribe triggered the call
          return {
            data: {
              conversation: { ...result.data.conversation, id: conversationId },
              recentTurns: result.data.recentTurns,
              totalTurnCount: result.data.totalTurnCount,
              pendingApprovals: result.data.pendingApprovals,
            },
          };
        },
        async loadTurnHistory() {
          return { data: { turns: [], totalCount: 0, hasMore: false } };
        },
        async getStreamReplay() {
          return { data: { events: [] } };
        },
      },
      streamEventBridge: new FakeEventBridge(),
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      // Use distinct conversation ids so each queued message independently
      // attempts an openConversation daemon call.
      for (let index = 0; index < 65; index += 1) {
        ws.send(JSON.stringify({ type: 'subscribe', conversationId: `conv-${index}` }));
      }

      await waitForCloseOrError(ws);

      // How many calls happened before the close is itself a race (whether
      // the ws library delivers all 65 frames in one synchronous batch, or
      // with event-loop turns between them, decides whether message #1's
      // queued handler gets to start before the overflow check closes the
      // connection out from under it) — 0 or 1 are both legitimate. What
      // must never happen is a FURTHER call after this point, from one of
      // the other 64 queued handlers draining once connection.isClosed is
      // already true.
      const openCallsAtClose = openCalls;
      assert.ok(
        openCallsAtClose <= 1,
        `Expected at most 1 openConversation call before close, got ${openCallsAtClose}`,
      );

      // Release the initially blocked daemon call and let all queued handlers drain.
      pendingOpen.resolve({
        data: {
          conversation: {
            id: 'conv-0',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turnCount: 0,
            pendingInstructionCount: 0,
          },
          recentTurns: [],
          totalTurnCount: 0,
          pendingApprovals: [],
        },
      });

      // Allow the message-queue promise chain to drain fully so any queued
      // handlers that would (incorrectly) call openConversation have a
      // chance to run. This polls the chain's own observable progress
      // (openCalls going quiet) rather than guessing a fixed grace period.
      await waitForStable(() => openCalls, 200);

      assert.equal(
        openCalls,
        openCallsAtClose,
        'queued handlers must not call openConversation after overflow close',
      );
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('forwards bridge stream events to subscribed websocket clients', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    ws.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
    const subscribed = await waitForMessageMatching(ws, (m) => m['type'] === 'subscribed');
    assert.equal(subscribed['type'], 'subscribed');

    const event = makeStreamEvent(3);
    streamEventBridge.emitStreamEvent('conv-1', event);

    const forwarded = await waitForMessageMatching(ws, (m) => m['type'] === 'stream-event');
    assert.equal(forwarded['type'], 'stream-event');
    assert.equal(forwarded['conversationId'], 'conv-1');
    assert.deepEqual(forwarded['event'], event);
  });

  it('rejects missing session cookie with 401', async () => {
    const status = await expectUnexpectedResponse(port);
    assert.equal(status, 401);
  });

  it('returns a structured JSON body for rejected upgrades', async () => {
    const response = await expectUnexpectedResponseBody(port);
    assert.equal(response.status, 401);
    const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'SESSION_NOT_FOUND');
  });

  it('rejects expired sessions with 401', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    clock.advance(60_001);

    const status = await expectUnexpectedResponse(port, { sessionId: session.id });
    assert.equal(status, 401);
  });

  it('rejects idle sessions with 401', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    clock.advance(30_001);

    const status = await expectUnexpectedResponse(port, { sessionId: session.id });
    assert.equal(status, 401);
  });

  it('rejects wrong origin with 403', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const status = await expectUnexpectedResponse(port, {
      sessionId: session.id,
      origin: 'http://evil.example.com',
    });
    assert.equal(status, 403);
  });

  it('rate limits repeated websocket upgrades from the same source', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    for (let index = 0; index < 30; index += 1) {
      const ws = await connectWebSocket(port, { sessionId: session.id });
      openSockets.push(ws);
    }

    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 429);
    const payload = JSON.parse(response.body) as {
      code?: string;
      ok?: boolean;
      retryAfterMs?: number;
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'RATE_LIMITED');
    assert.equal(payload.retryAfterMs, 5_000);
  });

  it('shares the mutating rate-limit budget between HTTP requests and websocket upgrades', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');

      for (let index = 0; index < 30; index += 1) {
        const response = await fetch(`http://127.0.0.1:${localPort}/not-found`, {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
          },
        });
        assert.equal(response.status, 401);
      }

      const response = await expectUnexpectedResponseBody(localPort, { sessionId: session.id });
      assert.equal(response.status, 429);
      const payload = JSON.parse(response.body) as {
        code?: string;
        ok?: boolean;
        retryAfterMs?: number;
      };
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'RATE_LIMITED');
      assert.equal(payload.retryAfterMs, 5_000);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('destroys non-/ws upgrades without registering a connection', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws`, {
      headers: {
        Origin: ORIGIN,
        Cookie: `__session=${session.id}`,
      },
    });

    await waitForCloseOrError(ws);
    assert.equal(gw.connectionRegistry.size, 0);
  });

  it('broadcasts expiring-soon notifications to open connections', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    clock.advance(50_001);
    await gw.sessionService.validate(session.id);

    const message = await waitForMessageMatching(ws, (m) => m['type'] === 'session-expiring-soon');
    assert.equal(message['type'], 'session-expiring-soon');
  });

  it('replays expiring-soon state to sockets that connect after the warning window begins', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    clock.advance(50_001);
    gw.sessionService.touchActivity(session.id);
    await gw.sessionService.validate(session.id);

    const ws = createWebSocket(port, { sessionId: session.id });
    const messagesPromise = waitForMessages(ws, 2);
    await once(ws, 'open');
    openSockets.push(ws);

    const messages = await messagesPromise;
    assert.equal(messages[0]?.['type'], 'daemon-restored');
    assert.equal(messages[1]?.['type'], 'session-expiring-soon');
  });

  it('broadcasts daemon outage and recovery messages', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws);

    healthResult = false;
    await gw.heartbeat.tick();
    const down = await waitForMessageMatching(ws, (m) => m['type'] === 'daemon-unavailable');
    assert.equal(down['type'], 'daemon-unavailable');

    healthResult = true;
    const recoveryMessagesPromise = waitForMessages(ws, 2);
    await gw.heartbeat.tick();
    const recoveryMessages = await recoveryMessagesPromise;
    assert.deepEqual(
      recoveryMessages.map((message) => message['type']),
      ['daemon-restored', 'session-active'],
    );
  });

  it('replays daemon-unavailable state to sockets that connect after daemon failure', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    await gw.sessionService.markDaemonDown(session.id);

    const ws = createWebSocket(port, { sessionId: session.id });
    const messagePromise = waitForMessage(ws);
    await once(ws, 'open');
    openSockets.push(ws);

    const message = await messagePromise;
    assert.equal(message['type'], 'daemon-unavailable');
  });

  it('replays expiring-soon alongside daemon-unavailable for degraded near-expiry reconnects', async () => {
    const localServer = createServer();
    const localClock = new FakeClock(Date.now());
    const localGateway = createGatewayApp({
      server: localServer,
      clock: localClock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 500,
        warningThresholdMs: 250,
        maxExtensions: 1,
        extensionDurationMs: 500,
        idleTimeoutMs: 5_000,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      localClock.advance(300);
      await localGateway.sessionService.markDaemonDown(session.id);

      const ws = createWebSocket(localPort, { sessionId: session.id });
      const messagesPromise = waitForMessages(ws, 2);
      await once(ws, 'open');
      const messages = await messagesPromise;
      openSockets.push(ws);

      assert.equal(messages[0]?.['type'], 'daemon-unavailable');
      assert.equal(messages[1]?.['type'], 'session-expiring-soon');
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('returns 500 for non-GatewayError exceptions during validation', async () => {
    const sessionService = gw.sessionService;
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const originalValidate = sessionService.validate.bind(sessionService);
    sessionService.validate = async () => {
      throw new Error('unexpected database error');
    };

    try {
      const status = await expectUnexpectedResponse(port, { sessionId: session.id });
      assert.equal(status, 500);
    } finally {
      sessionService.validate = originalValidate;
    }
  });

  it('terminates connections when the session lifetime elapses', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 25,
        warningThresholdMs: 10,
        maxExtensions: 1,
        extensionDurationMs: 25,
        idleTimeoutMs: 1_000,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      // Warning timer fires before hard expiry
      const warning = await waitForMessageMatching(
        ws,
        (m) => m['type'] === 'session-expiring-soon',
      );
      assert.equal(warning['type'], 'session-expiring-soon');

      const termination = await waitForMessageMatching(
        ws,
        (m) => m['type'] === 'session-terminated',
      );
      assert.equal(termination['type'], 'session-terminated');
      await once(ws, 'close');
      assert.equal(localGateway.connectionRegistry.getBySession(session.id).size, 0);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('terminates all session connections on logout', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const wsA = await connectWebSocket(port, { sessionId: session.id });
    const wsB = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(wsA, wsB);

    await gw.sessionService.logout(session.id);

    const [messageA, messageB] = await Promise.all([waitForMessage(wsA), waitForMessage(wsB)]);
    assert.equal(messageA['type'], 'session-terminated');
    assert.equal(messageB['type'], 'session-terminated');
    await Promise.all([once(wsA, 'close'), once(wsB, 'close')]);
    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 0);
  });

  it('uses a standard HTTP reason phrase instead of the error message', async () => {
    const sessionService = gw.sessionService;
    const session = await sessionService.create('op-1', '127.0.0.1');
    const originalValidate = sessionService.validate.bind(sessionService);
    sessionService.validate = async () => {
      throw new GatewayError('SESSION_EXPIRED', 'Secret internal detail', 401);
    };

    try {
      const headers: Record<string, string> = {
        Origin: ORIGIN,
        Cookie: `__session=${session.id}`,
      };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      const [, response] = (await once(ws, 'unexpected-response')) as [
        unknown,
        NodeJS.ReadableStream & { statusCode?: number; statusMessage?: string },
      ];

      // Status line must use standard phrase, not the custom error message
      assert.equal(response.statusCode, 401);
      assert.equal(response.statusMessage, 'Unauthorized');

      // JSON body still contains the detailed message
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      await once(response, 'end');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message?: string };
      assert.equal(body.message, 'Secret internal detail');
    } finally {
      sessionService.validate = originalValidate;
    }
  });

  it('sends session-expiring-soon purely from time progression without explicit validate()', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 500,
        warningThresholdMs: 250,
        maxExtensions: 1,
        extensionDurationMs: 500,
        idleTimeoutMs: 5_000,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });
      openSockets.push(ws);

      // No explicit validate() call — warning fires purely from the scheduled timer
      const message = await waitForMessageMatching(
        ws,
        (m) => m['type'] === 'session-expiring-soon',
      );
      assert.equal(message['type'], 'session-expiring-soon');
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('close() drains active connections and clears registry entries', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');
    const ws = await connectWebSocket(port, { sessionId: session.id });
    // Do not push to openSockets — close() should handle cleanup

    assert.ok(gw.connectionRegistry.size >= 1, 'Connection should be registered');

    gw.wsServer?.close();
    await waitForCloseOrError(ws);

    assert.equal(gw.connectionRegistry.size, 0, 'Registry should be empty after close()');
  });

  it('closes connected sockets when the idle timeout elapses', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 5_000,
        warningThresholdMs: 500,
        maxExtensions: 1,
        extensionDurationMs: 5_000,
        idleTimeoutMs: 25,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });

      await waitForCloseOrError(ws);
      assert.equal(localGateway.connectionRegistry.getBySession(session.id).size, 0);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('refreshes the idle timeout when inbound websocket messages arrive', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 5_000,
        warningThresholdMs: 500,
        maxExtensions: 1,
        extensionDurationMs: 5_000,
        idleTimeoutMs: 40,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const ws = await connectWebSocket(localPort, { sessionId: session.id });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      ws.send('keepalive');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      assert.equal(ws.readyState, WebSocket.OPEN);

      await waitForCloseOrError(ws);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  it('keeps sibling session sockets alive when one socket refreshes shared activity', async () => {
    const localServer = createServer();
    const localGateway = createGatewayApp({
      server: localServer,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      sessionConfig: {
        sessionLifetimeMs: 5_000,
        warningThresholdMs: 500,
        maxExtensions: 1,
        extensionDurationMs: 5_000,
        idleTimeoutMs: 50,
      },
    });
    const requestListener = getRequestListener(localGateway.app.fetch);
    localServer.on('request', (request, response) => {
      void requestListener(request, response);
    });
    const localPort = await listen(localServer);

    try {
      const session = await localGateway.sessionService.create('op-1', '127.0.0.1');
      const wsA = await connectWebSocket(localPort, { sessionId: session.id });
      const wsB = await connectWebSocket(localPort, { sessionId: session.id });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      wsA.send('keepalive');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 35);
      });

      assert.equal(wsA.readyState, WebSocket.OPEN);
      assert.equal(wsB.readyState, WebSocket.OPEN);

      await Promise.all([waitForCloseOrError(wsA), waitForCloseOrError(wsB)]);
    } finally {
      localGateway.wsServer?.close();
      localGateway.heartbeat.stop();
      await closeServer(localServer);
    }
  });

  // ─── T035: reconnect with invalid session ──────────────────────────────
  // FR-025: reconnect attempts with expired or invalidated sessions are
  // rejected before any replay occurs. These tests establish a valid first
  // connection, transition the session to a terminal state, then attempt a
  // second WS upgrade and assert rejection with the correct status/code.

  it('rejects reconnect after session expires with 401 SESSION_EXPIRED', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    // First connection succeeds
    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);
    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 1);

    // Close the first connection (simulates browser tab close / network drop)
    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    // Advance clock past session lifetime to trigger expiry
    clock.advance(60_001);

    // Reconnect attempt should be rejected with 401
    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 401);
    const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'SESSION_EXPIRED');
  });

  it('rejects reconnect after session is invalidated with 401 SESSION_INVALIDATED', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    // First connection succeeds
    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);
    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 1);

    // Close the first connection
    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    // Invalidate the session (e.g., admin action, concurrent session eviction)
    await gw.sessionService.invalidate(session.id, 'admin-revoked');

    // Reconnect attempt should be rejected with 401
    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 401);
    const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'SESSION_INVALIDATED');
  });

  it('rejects reconnect after logout with 401 SESSION_NOT_FOUND', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    // First connection succeeds
    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);

    // Close the first connection
    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    // Log out the session
    await gw.sessionService.logout(session.id);

    // Reconnect attempt should be rejected with 401
    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 401);
    const payload = JSON.parse(response.body) as { code?: string; ok?: boolean };
    assert.equal(payload.ok, false);
    // logged-out falls through to SESSION_NOT_FOUND in validate()
    assert.equal(payload.code, 'SESSION_NOT_FOUND');
  });

  it('does not register a connection or replay events when reconnecting with an expired session', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    // First connection: subscribe to a conversation and receive events
    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);
    ws1.send(JSON.stringify({ type: 'subscribe', conversationId: 'conv-1' }));
    await waitForMessage(ws1); // subscribed ack

    // Push an event into the buffer for conv-1
    streamEventBridge.emitStreamEvent('conv-1', makeStreamEvent(1));
    await waitForMessage(ws1); // stream-event

    // Close the first connection
    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    // Expire the session
    clock.advance(60_001);

    // Attempt reconnect — should be rejected
    const status = await expectUnexpectedResponse(port, { sessionId: session.id });
    assert.equal(status, 401);

    // No connection should be registered for this session
    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 0);
  });

  it('does not register a connection when reconnecting with an invalidated session', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    // First connection
    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);

    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    // Invalidate
    await gw.sessionService.invalidate(session.id, 'security-concern');

    // Attempt reconnect
    const status = await expectUnexpectedResponse(port, { sessionId: session.id });
    assert.equal(status, 401);

    // Registry must remain empty — no partial registration
    assert.equal(gw.connectionRegistry.getBySession(session.id).size, 0);
  });

  it('rejects expired session reconnect with structured JSON error body', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);
    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    clock.advance(60_001);

    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 401);
    const body = JSON.parse(response.body) as {
      ok?: boolean;
      code?: string;
      category?: string;
      message?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_EXPIRED');
    assert.equal(body.category, 'session');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message!.length > 0);
  });

  it('rejects invalidated session reconnect with structured JSON error body', async () => {
    const session = await gw.sessionService.create('op-1', '127.0.0.1');

    const ws1 = await connectWebSocket(port, { sessionId: session.id });
    openSockets.push(ws1);
    ws1.close();
    await waitForCloseOrError(ws1);
    openSockets.splice(openSockets.indexOf(ws1), 1);

    await gw.sessionService.invalidate(session.id, 'compromised');

    const response = await expectUnexpectedResponseBody(port, { sessionId: session.id });
    assert.equal(response.status, 401);
    const body = JSON.parse(response.body) as {
      ok?: boolean;
      code?: string;
      category?: string;
      message?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_INVALIDATED');
    assert.equal(body.category, 'session');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message!.length > 0);
  });
});
