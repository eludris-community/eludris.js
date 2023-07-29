import { sleep } from './shared.js';
import type {
  CreatePasswordResetCode,
  EffisRateLimits,
  FileData,
  FileUpload,
  InstanceInfo,
  Message,
  MessageCreate,
  OprishRateLimits,
  PasswordDeleteCredentials,
  ResetPassword,
  Session,
  SessionCreate,
  SessionCreated,
  UpdateUser,
  UpdateUserProfile,
  User,
  UserCreate,
} from 'eludris-api-types/v0.4.0-alpha1';
import { ROUTES } from 'eludris-api-types/v0.4.0-alpha1';
import log from 'npmlog';

type KeysOfUnion<T> = T extends T ? keyof T : never;
type ValidRoutes = KeysOfUnion<OprishRateLimits | EffisRateLimits>;

/**
 * A client for interacting with the Eludris REST API.
 *
 * @internal @property apiUrl - The base URL used for requests.
 * @internal @property authToken - The auth token used.
 * @internal @property instanceInfo - The instance info.
 * @internal @property rateLimitBuckets - The rate limit buckets.
 */
export default class RESTClient {
  apiUrl: string;
  authToken: string | undefined = undefined;
  instanceInfo: InstanceInfo | undefined = undefined;
  rateLimitBuckets: Map<
    ValidRoutes,
    {
      reset_at: number;
      remaining: number;
    }
  > = new Map();

  /**
   * Create a new REST client.
   *
   * @example
   *   import { RESTClient } from 'eludris.js';
   *
   *   const rest = new RESTClient({});
   *
   * @param apiUrl - The base api URL to use.
   */
  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  private async fetch(
    to: 'api' | 'cdn',
    route: ValidRoutes, // This is needed for rate limiting.
    path: string,
    options: RequestInit = {
      headers: {
        'User-Agent': 'eludris.js',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    },
  ): Promise<Response> {
    const requestId = Math.random().toString(36).substring(7);
    log.silly('fetch', `Starting request ${path} with id ${requestId}.`);

    await this.processRateLimits(route, requestId);

    if (!this.instanceInfo && to === 'cdn') {
      log.info('fetch', 'Fetching instance info.');
      await this.setUp();
    }

    let url = to === 'api' ? this.apiUrl : this.instanceInfo!.effis_url;

    // Requests to the cdn don't need authentication.
    if (to !== 'cdn' && this.authToken) {
      // Authenticate where we can.
      // Make sure we don't overwrite existing an existing Authorization header.

      options.headers = {
        Authorization: this.authToken,
        ...options.headers,
      };
    }

    const response = await fetch(url + path, options);

    if (!response.ok && response.status !== 429) {
      throw new Error(response.statusText);
    }

    this.parseRateLimitHeaders(response, route);

    if (response.status === 429) {
      log.verbose('ratel', 'We are getting rate limited.');
      return await this.fetch(to, route, path, options);
    }

    log.verbose(
      'fetch',
      `Finished request ${path} ${requestId} with status ${response.status}.`,
    );

    return response;
  }

  private async setUp(): Promise<InstanceInfo> {
    this.instanceInfo = await this.getInstanceInfo({
      withRateLimits: false,
    });
    return this.instanceInfo;
  }

  private async fetchJson<T>(
    baseUrl: 'api' | 'cdn',
    route: ValidRoutes, // This is needed for rate limiting.
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetch(baseUrl, route, path, options);
    return await response.json();
  }

  private async processRateLimits(route: ValidRoutes, id: string) {
    let bucket = this.rateLimitBuckets.get(route)!;

    if (bucket && bucket.remaining === 0) {
      const now = Date.now();
      if (Date.now() < bucket.reset_at) {
        // We need to wait.
        log.silly(
          'ratel',
          `No remaining requests for ${id}, waiting ${
            bucket.reset_at - now
          }ms for rate limit to reset.`,
        );
        await sleep(bucket.reset_at - now);

        log.silly('ratel', `Rate limit for ${route} reset.`);
      } else {
        log.silly('ratel', `No need to wait for ${route} rate limit.`);
      }
      this.rateLimitBuckets.delete(route);
    }
  }

  private parseRateLimitHeaders(response: Response, route: ValidRoutes) {
    const requestsSent = response.headers.get('X-RateLimit-Request-Count');
    const maxRequests = response.headers.get('X-RateLimit-Max');
    const lastReset = response.headers.get('X-RateLimit-Last-Reset');
    const resetAfter = response.headers.get('X-RateLimit-Reset');

    if (requestsSent && maxRequests && lastReset && resetAfter) {
      this.rateLimitBuckets.set(route, {
        remaining: parseInt(maxRequests) - parseInt(requestsSent),
        reset_at: parseInt(lastReset) + parseInt(resetAfter),
      });
    }
  }

  async downloadFile({
    bucket,
    id,
  }: {
    bucket: string;
    id: number;
  }): Promise<Blob> {
    const response = await this.fetch(
      'cdn',
      bucket === 'attachments' ? 'attachments' : 'fetch_file',
      ROUTES.downloadFile('', bucket, id),
    );
    return await response.blob();
  }

  async downloadAttachment({ id }: { id: number }): Promise<Blob> {
    return await this.downloadFile({
      bucket: 'attachments',
      id: id,
    });
  }

  async downloadStaticFile({ name }: { name: string }): Promise<Blob> {
    const response = await this.fetch(
      'cdn',
      'fetch_file',
      ROUTES.downloadStaticFile('', name),
    );
    return await response.blob();
  }

  async getAttachmentData({ id }: { id: number }): Promise<FileData> {
    return await this.fetchJson<FileData>(
      'cdn',
      'attachments',
      ROUTES.getAttachmentData('', id),
    );
  }

  async uploadFile({
    bucket,
    file,
    spoiler,
  }: { bucket: string } & FileUpload): Promise<FileData> {
    const formData = new FormData();
    formData.append('file', file as File);
    formData.append('spoiler', spoiler.toString());
    return await this.fetchJson<FileData>(
      'cdn',
      'fetch_file',
      ROUTES.uploadFile('', bucket),
      {
        method: 'POST',
        body: formData,
      },
    );
  }

  async uploadAttachment({ file, spoiler }: FileUpload): Promise<FileData> {
    return await this.uploadFile({
      bucket: 'attachments',
      file,
      spoiler,
    });
  }

  async getInstanceInfo({
    withRateLimits,
  }: {
    withRateLimits: boolean;
  }): Promise<InstanceInfo> {
    return await this.fetchJson<InstanceInfo>(
      'api',
      'get_instance_info',
      ROUTES.getInstanceInfo('', withRateLimits),
    );
  }

  async createMessage(message: MessageCreate): Promise<Message> {
    return await this.fetchJson<Message>(
      'api',
      'create_message',
      ROUTES.createMessage(''),
      {
        method: 'POST',
        body: JSON.stringify(message),
      },
    );
  }

  async createSession(sessionCreate: SessionCreate): Promise<SessionCreated> {
    return await this.fetchJson<SessionCreated>(
      'api',
      'create_session',
      ROUTES.createSession(''),
      {
        method: 'POST',
        body: JSON.stringify(sessionCreate),
      },
    );
  }

  async deleteSession({
    sessionId,
    ...creds
  }: {
    sessionId: number;
  } & PasswordDeleteCredentials): Promise<void> {
    await this.fetch(
      'api',
      'delete_session',
      ROUTES.deleteSession('', sessionId),
      {
        body: JSON.stringify(creds),
        method: 'DELETE',
      },
    );
  }

  async getSessions(): Promise<Session[]> {
    return await this.fetchJson<Session[]>(
      'api',
      'get_sessions',
      ROUTES.getSessions(''),
    );
  }

  async createPasswordResetCode(
    createPasswordResetCode: CreatePasswordResetCode,
  ): Promise<void> {
    await this.fetch(
      'api',
      'create_password_reset_code',
      ROUTES.createPasswordResetCode(''),
      {
        method: 'POST',
        body: JSON.stringify(createPasswordResetCode),
      },
    );
  }

  async createUser(userCreate: UserCreate): Promise<User> {
    return await this.fetchJson<User>(
      'api',
      'create_user',
      ROUTES.createUser(''),
      {
        method: 'POST',
        body: JSON.stringify(userCreate),
      },
    );
  }

  async deleteUser(creds: PasswordDeleteCredentials): Promise<void> {
    await this.fetch('api', 'delete_user', ROUTES.deleteUser(''), {
      method: 'DELETE',
      body: JSON.stringify(creds),
    });
  }

  async getUser({ userId }: { userId: number }): Promise<User> {
    return await this.fetchJson<User>(
      'api',
      this.authToken ? 'get_user' : 'guest_get_user',
      ROUTES.getUser('', userId),
    );
  }

  async getUserByName({ username }: { username: string }): Promise<User> {
    return await this.fetchJson<User>(
      'api',
      this.authToken ? 'get_user' : 'guest_get_user',
      ROUTES.getUserWithUsername('', username),
    );
  }

  async resetPassword(resetPassword: ResetPassword): Promise<void> {
    await this.fetch('api', 'reset_password', ROUTES.resetPassword(''), {
      method: 'POST',
      body: JSON.stringify(resetPassword),
    });
  }

  async updateProfile(updateUserProfile: UpdateUserProfile): Promise<User> {
    return await this.fetchJson<User>(
      'api',
      'update_profile',
      ROUTES.updateProfile(''),
      {
        method: 'PATCH',
        body: JSON.stringify(updateUserProfile),
      },
    );
  }

  /**
   * @param updateUser - The user to update. @link eludris-api-types.UpdateUser
   * @returns
   */
  async updateUser(updateUser: UpdateUser): Promise<User> {
    return await this.fetchJson<User>(
      'api',
      'update_user',
      ROUTES.updateUser(''),
      {
        method: 'PATCH',
        body: JSON.stringify(updateUser),
      },
    );
  }

  /**
   * Verify your email address.
   *
   * @param code - The code to verify.
   */
  async verifyUser({ code }: { code: number }): Promise<void> {
    await this.fetch('api', 'verify_user', ROUTES.verifyUser('', code), {
      method: 'POST',
    });
  }
}
