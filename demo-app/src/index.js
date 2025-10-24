import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { collectDefaultMetrics, Counter, Histogram, Gauge, Registry } from 'prom-client';
import fetch from 'node-fetch';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SERVICE_NAME = process.env.SERVICE_NAME || 'demo-orders-api';
const ORDER_EXPORTER_URL = process.env.ORDER_EXPORTER_URL || 'http://order-exporter:9100/custom_metrics';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: SERVICE_NAME }
});

const app = express();
app.use(express.json());
app.use(pinoHttp({ logger }));

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'demo_' });

const requestCounter = new Counter({
  name: 'demo_request_total',
  help: 'Total number of HTTP requests',
  labelNames: ['service', 'route', 'method', 'status']
});

const requestErrorCounter = new Counter({
  name: 'demo_request_errors_total',
  help: 'Total number of failed HTTP requests',
  labelNames: ['service', 'route', 'method', 'status']
});

const requestDuration = new Histogram({
  name: 'demo_request_duration_seconds',
  help: 'Request latency distribution in seconds',
  labelNames: ['service', 'route', 'method', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

const orderValueGauge = new Gauge({
  name: 'demo_order_last_value_usd',
  help: 'Value of the most recent order in USD',
  labelNames: ['service', 'region']
});

const lastExporterRefreshGauge = new Gauge({
  name: 'demo_order_exporter_last_refresh_seconds',
  help: 'Unix timestamp of last successful custom exporter pull',
  labelNames: ['service']
});

registry.registerMetric(requestCounter);
registry.registerMetric(requestErrorCounter);
registry.registerMetric(requestDuration);
registry.registerMetric(orderValueGauge);
registry.registerMetric(lastExporterRefreshGauge);

const simulateLatency = () => new Promise(resolve => setTimeout(resolve, Math.random() * 400));

const regions = ['us-east', 'us-west', 'eu-central'];

async function refreshExporterSnapshot() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(ORDER_EXPORTER_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Bad response: ${response.status}`);
    }
    const payload = await response.json();
    const { region, latest_order_value } = payload;
    const chosenRegion = region || regions[Math.floor(Math.random() * regions.length)];
    orderValueGauge.set({ service: SERVICE_NAME, region: chosenRegion }, latest_order_value);
    lastExporterRefreshGauge.set({ service: SERVICE_NAME }, Date.now() / 1000);
    logger.info({
      event: 'exporter.refresh',
      latest_order_value: latest_order_value,
      region: chosenRegion
    }, 'Refreshed exporter snapshot');
  } catch (error) {
    logger.warn({ err: error, event: 'exporter.refresh_failed' }, 'Failed to refresh exporter snapshot');
  }
  clearTimeout(timeoutId);
}

setInterval(refreshExporterSnapshot, 30_000);
refreshExporterSnapshot();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME });
});

app.get('/orders', async (req, res) => {
  const start = Date.now();
  const orderId = randomUUID();
  const region = regions[Math.floor(Math.random() * regions.length)];
  const amount = Number((Math.random() * 200 + 5).toFixed(2));
  const userId = `user-${Math.ceil(Math.random() * 5)}`;
  const traceId = req.id ?? randomUUID();

  try {
    await simulateLatency();
    if (Math.random() < 0.1) {
      throw new Error('Simulated downstream dependency failure');
    }
    const response = {
      orderId,
      region,
      amount,
      status: 'fulfilled',
      traceId
    };
    res.json(response);
    logger.info({
      event: 'order.fulfilled',
      order_id: orderId,
      amount,
      region,
      user_id: userId,
      trace_id: traceId
    }, 'Order fulfilled');
    const statusCode = res.statusCode;
    const labels = {
      service: SERVICE_NAME,
      route: '/orders',
      method: req.method,
      status: String(statusCode)
    };
    const durationSeconds = (Date.now() - start) / 1000;
    requestCounter.inc(labels);
    requestDuration.observe(labels, durationSeconds);
  } catch (error) {
    const statusCode = 502;
    res.status(statusCode).json({ error: 'order service unavailable', traceId });
    logger.error({
      err: error,
      event: 'order.failed',
      order_id: orderId,
      region,
      user_id: userId,
      trace_id: traceId
    }, 'Order processing failed');
    const labels = {
      service: SERVICE_NAME,
      route: '/orders',
      method: req.method,
      status: String(statusCode)
    };
    const durationSeconds = (Date.now() - start) / 1000;
    requestCounter.inc(labels);
    requestErrorCounter.inc(labels);
    requestDuration.observe(labels, durationSeconds);
  }
});

app.post('/alert', (req, res) => {
  logger.warn({
    event: 'alertmanager.webhook',
    alert: req.body
  }, 'Received alertmanager webhook');
  res.status(202).json({ received: true });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use((err, _req, res, _next) => {
  logger.error({ err, event: 'unhandled.error' }, 'Unhandled error');
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  logger.info({ event: 'startup', port: PORT }, `Listening on port ${PORT}`);
});
