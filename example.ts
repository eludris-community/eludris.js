import { GatewayClient, RESTClient } from 'eludris.js';

const rest = new RESTClient('https://api.eludris.gay/next');

const sessionCreated = await rest.createSession({
  client: 'eludris.js',
  platform: 'eludris.js',
  password: 'youshallnotpass',
  identifier: 'teaishealthy',
});
rest.authToken = sessionCreated.token;

const gateway = new GatewayClient({
  rest,
  logEvents: true,
});
await gateway.connect();
