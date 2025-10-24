# Demo Orders Service Observability Runbook

## Service Overview
- **Service name**: `demo-orders-api`
- **Dependencies**: Custom order exporter (`order-exporter`), Prometheus, Loki, Alertmanager
- **Critical paths**: `/orders` endpoint, exporter refresh workflow

## Key Metrics (Grafana › Observability › Demo Orders Service Overview)
- `demo_request_total` / `demo_request_errors_total`
  - Watch the **Request Rate by Status** panel for spikes in `5xx` responses.
  - The **Error Rate %** stat panel fires a warning >5% and critical >10% errors.
- `demo_request_duration_seconds`
  - The **p90 Latency** panel should remain <500ms under normal load.
- `demo_order_last_value_usd`
  - Sudden drops to zero typically signal data plane issues with the exporter.
- `demo_order_exporter_last_refresh_seconds`
  - Used by the `OrderExporterStaleData` alert; indicates exporter freshness.

## Important Alerts
- **DemoAppHighErrorRate**
  - Trigger: error rate ≥10% sustained for 1 minute (2-minute lookback).
  - Immediate actions: inspect the logs dashboard for `order.failed` events, confirm downstream dependencies.
- **OrderExporterStaleData**
  - Trigger: exporter refresh gap >120 seconds.
  - Immediate actions: confirm the `order-exporter` container is running and restart if necessary.

Alertmanager webhooks are delivered to `POST /alert` on the demo app. The service logs each alert with the `alertmanager.webhook` event name.

## Logs Triage Workflow (Grafana › Observability › Demo Orders Service Logs)
1. Use the `service` variable to scope to `demo-orders-api`.
2. Filter logs with `|=` and `!=` to isolate event names (`event="order.failed"`).
3. Correlate `trace_id` values back to metrics by searching within the log stream.
4. The **Error Logs (5m)** stat panel shows spike counts; align with metric alert windows.

## Exporter Health Checks
- Endpoint: `GET http://order-exporter:9100/health`
- Metrics: `GET http://order-exporter:9100/metrics`
- Custom JSON snapshot: `GET http://order-exporter:9100/custom_metrics`

If the exporter becomes unavailable:
1. Verify container status: `docker compose ps order-exporter`.
2. Review logs: `docker compose logs -f order-exporter`.
3. Restart if necessary using `docker compose restart order-exporter`.

## Resiliency Playbook
- **High latency**: confirm container health with `docker compose ps demo-app`; scale by adding load-balanced replicas if desired (e.g., clone service definition).
- **Prometheus down**: metric panels gray out; restart with `docker compose restart prometheus`.
- **Loki ingestion issues**: inspect promtail logs (`docker compose logs -f promtail`) and ensure `/var/log` and `/var/lib/docker/containers` mounts are available.

## Useful Queries
- Error ratio (Prometheus):
  ```promql
  sum(rate(demo_request_errors_total[5m])) / sum(rate(demo_request_total[5m]))
  ```
- Slow requests (>1s) count:
  ```promql
  sum(rate(demo_request_duration_seconds_bucket{le="+Inf"}[5m])) - sum(rate(demo_request_duration_seconds_bucket{le="1"}[5m]))
  ```
- Loki grep for failed orders:
  ```logql
  {service="demo-orders-api", event="order.failed"}
  ```

## Escalation Guidance
- SRE on-call owns remediation when alerts persist >15 minutes.
- For infrastructure-level outages (Prometheus/Loki unavailable), notify the platform team.
- Capture key Grafana panel screenshots and alert timelines before closing incidents.
