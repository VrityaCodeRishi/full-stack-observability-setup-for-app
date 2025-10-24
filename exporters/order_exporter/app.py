import random
import threading
import time
from datetime import datetime

from flask import Flask, Response, jsonify
from prometheus_client import (CONTENT_TYPE_LATEST, CollectorRegistry, Counter,
                               Gauge, Histogram, generate_latest)

app = Flask(__name__)
registry = CollectorRegistry()

orders_total = Counter(
    'demo_order_exporter_orders_total',
    'Orders observed grouped by status',
    ['status'],
    registry=registry
)

order_value = Gauge(
    'demo_order_exporter_latest_order_value_usd',
    'Value of the latest order observed',
    registry=registry
)

order_backlog = Gauge(
    'demo_order_exporter_backlog_total',
    'Synthetic backlog size for the warehouse queue',
    registry=registry
)

processing_latency = Histogram(
    'demo_order_exporter_processing_seconds',
    'Synthetic processing latency for order fulfillment',
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5),
    registry=registry
)

last_refresh_timestamp = Gauge(
    'demo_order_exporter_last_refresh_timestamp_seconds',
    'Unix timestamp of the last synthetic order generated',
    registry=registry
)

state = {
    'latest_order_value': 0.0,
    'region': 'us-east-1',
    'backlog': 0,
    'last_generated': datetime.utcnow().isoformat()
}
state_lock = threading.Lock()


def generate_metrics():
    while True:
        start_time = time.perf_counter()
        status = 'fulfilled' if random.random() > 0.12 else 'failed'
        value = round(random.uniform(20, 250), 2)
        backlog = max(0, int(random.gauss(40, 10)))
        processing_time = random.expovariate(1 / 0.5)

        orders_total.labels(status=status).inc()
        order_value.set(value)
        order_backlog.set(backlog)
        processing_latency.observe(processing_time)
        last_refresh_timestamp.set(time.time())

        with state_lock:
            state['latest_order_value'] = value
            state['region'] = random.choice(['us-east-1', 'us-west-2', 'eu-central-1'])
            state['backlog'] = backlog
            state['last_generated'] = datetime.utcnow().isoformat()

        elapsed = time.perf_counter() - start_time
        sleep_for = max(5, random.randint(5, 15)) - elapsed
        time.sleep(max(sleep_for, 1))


def start_background_thread():
    thread = threading.Thread(target=generate_metrics, daemon=True)
    thread.start()


@app.route('/metrics')
def metrics():
    return Response(generate_latest(registry), mimetype=CONTENT_TYPE_LATEST)


@app.route('/custom_metrics')
def custom_metrics():
    with state_lock:
        payload = dict(state)
    return jsonify(payload)


@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'component': 'order-exporter'})


if __name__ == '__main__':
    start_background_thread()
    app.run(host='0.0.0.0', port=9100)
