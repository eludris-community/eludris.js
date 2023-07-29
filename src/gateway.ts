import type RESTClient from './client.js';
import { sleep } from './shared.js';
import { ClientPayload, ServerPayload } from 'eludris-api-types/v0.4.0-alpha1';
import WebSocket from 'isomorphic-ws';
import log from 'npmlog';
import { TypedEmitter } from 'tiny-typed-emitter';

type Payloads<T extends ServerPayload> = Extract<T, { d: any }>['d'];
type PayloadsFunction<T extends ServerPayload> = Payloads<T> extends undefined
  ? () => void
  : (data: Payloads<T>) => void;

type MessageEvents = {
  [K in ServerPayload['op']]: PayloadsFunction<
    Extract<ServerPayload, { op: K }>
  >;
} & {
  rawReceive: (data: string) => void;
  rawSend: (data: string) => void;
  ready: () => void;
  close: (code: number, reason: string) => void;
  error: (error: any) => void;
};

/**
 * A client for interacting with the Eludris gateway.
 *
 * @property events - The event emitter. You can listen to events using this.
 * @internal @property rest - The REST client used.
 * @internal @property ws - The WebSocket connection.
 * @internal @property interval - The interval for sending heartbeats.
 * @internal @property emitRawEvents - Whether to emit raw events.
 */
export default class GatewayClient {
  rest: RESTClient;
  ws: WebSocket | null = null;
  interval: number | null = null;
  emitRawEvents: boolean;
  events: TypedEmitter<MessageEvents> = new TypedEmitter<MessageEvents>();

  /**
   * Create a new gateway client.
   *
   * @example
   *   import { GatewayClient, RESTClient } from 'eludris.js';
   *
   *   // <snip> - Create your REST client and authenticate.
   *
   *   const gateway = new GatewayClient({
   *     rest,
   *     logEvents: true,
   *   });
   *
   * @param rest - The REST client to use.
   * @param logEvents - Whether to log events.
   * @param emitRawEvents - Whether to emit raw events.
   * @throws {Error} If `emitRawEvents` is false and `logEvents` is true.
   */
  constructor({
    rest,
    logEvents = false,
    emitRawEvents = undefined,
  }: {
    rest: RESTClient;
    logEvents?: boolean;
    emitRawEvents?: boolean | undefined;
  }) {
    if (emitRawEvents === false && logEvents === true) {
      throw new Error(
        '`emitRawEvents` cannot be false if `logEvents` is true.',
      );
    }
    this.emitRawEvents = emitRawEvents === undefined ? true : emitRawEvents;

    this.rest = rest;

    if (logEvents) {
      this.events.on('rawReceive', (data) => {
        log.silly('gatew', '<', data);
      });

      this.events.on('rawSend', (data) => {
        log.silly('gatew', '>', data);
      });
    }
  }

  /**
   * Connect to the gateway.
   *
   * @example
   *   await gateway.connect();
   *
   * @throws {Error} If the client is not authenticated.
   */
  async connect() {
    if (!this.rest.authToken) {
      throw new Error('No auth token.');
    }

    const instanceInfo =
      this.rest.instanceInfo ||
      (await this.rest.getInstanceInfo({ withRateLimits: false }));
    this.ws = new WebSocket(instanceInfo.pandemonium_url);

    this.ws.addEventListener('close', (event: any) => {
      this.events.emit('close', event.code, event.reason);
    });

    this.ws.addEventListener('error', (event: any) => {
      this.events.emit('error', event);
    });

    this.ws.addEventListener('message', async (event: any) => {
      const data: ServerPayload = JSON.parse(event.data);

      if (this.emitRawEvents) {
        this.events.emit('rawReceive', event.data);
      }

      // usual TS moment.
      if ('d' in data) {
        // @ts-ignore - typescript shouldn't be erroring here.
        this.events.emit(data.op, data.d);
      } else {
        this.events.emit(data.op);
      }

      if (data.op === 'HELLO') {
        await this.send({
          op: 'AUTHENTICATE',
          d: this.rest.authToken!,
        });
        log.verbose('gatew', 'Sent authentication payload.');
        this.heartbeat(data.d.heartbeat_interval);
      } else if (data.op === 'AUTHENTICATED') {
        log.verbose('gatew', 'Authenticated.');
        this.events.emit('ready');
      }
    });
  }

  private async heartbeat(heartbeatInterval: number) {
    if (!this.ws) {
      throw new Error('Not connected.');
    }

    // Wait a random amount of time before sending the first heartbeat.
    // This is to prevent all clients from sending a first heartbeat at the same time.
    // Also called jitter.
    await sleep(heartbeatInterval * Math.random());

    await this.send({
      op: 'PING',
    });

    this.interval = setInterval(async () => {
      await this.send({
        op: 'PING',
      });
    }, heartbeatInterval);
  }

  /**
   * Send data to the gateway.
   *
   * @param data - The data to send.
   * @throws {Error} If the client is not connected.
   */
  async send(data: ClientPayload) {
    if (!this.ws) {
      throw new Error('Not connected.');
    }

    const dataString = JSON.stringify(data);

    if (this.emitRawEvents) {
      this.events.emit('rawSend', dataString);
    }

    this.ws.send(dataString);
  }
}
