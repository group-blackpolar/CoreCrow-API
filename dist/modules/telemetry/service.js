export const statusWindows = ["1h", "6h", "24h"];
const windowMilliseconds = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
};
const bucketMilliseconds = 5 * 60 * 1000;
const latencyBounds = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const rounded = (value, digits = 2) => Number(value.toFixed(digits));
function percentile(histogram, total, ratio) {
    if (!total)
        return null;
    const target = Math.ceil(total * ratio);
    let observed = 0;
    for (let index = 0; index < histogram.length; index += 1) {
        observed += histogram[index] ?? 0;
        if (observed >= target)
            return latencyBounds[index] ?? latencyBounds.at(-1);
    }
    return latencyBounds.at(-1);
}
export class RequestTelemetry {
    now;
    startedAt;
    buckets = new Map();
    constructor(now = Date.now) {
        this.now = now;
        this.startedAt = now();
    }
    record(durationMs, statusCode) {
        if (!Number.isFinite(durationMs) || durationMs < 0)
            return;
        const now = this.now();
        const startedAt = Math.floor(now / bucketMilliseconds) * bucketMilliseconds;
        const bucket = this.buckets.get(startedAt) ?? {
            startedAt,
            requests: 0,
            totalLatencyMs: 0,
            errors4xx: 0,
            errors5xx: 0,
            latencyHistogram: Array.from({ length: latencyBounds.length + 1 }, () => 0),
        };
        bucket.requests += 1;
        bucket.totalLatencyMs += durationMs;
        if (statusCode >= 400 && statusCode < 500)
            bucket.errors4xx += 1;
        if (statusCode >= 500)
            bucket.errors5xx += 1;
        const latencyIndex = latencyBounds.findIndex((bound) => durationMs <= bound);
        bucket.latencyHistogram[latencyIndex === -1 ? latencyBounds.length : latencyIndex] += 1;
        this.buckets.set(startedAt, bucket);
        const oldest = now - windowMilliseconds["24h"] - bucketMilliseconds;
        for (const key of this.buckets.keys())
            if (key < oldest)
                this.buckets.delete(key);
    }
    summary(window) {
        const now = this.now();
        const requestedStart = now - windowMilliseconds[window];
        const observedStart = Math.max(this.startedAt, requestedStart);
        const firstBucket = Math.floor(observedStart / bucketMilliseconds) * bucketMilliseconds;
        const lastBucket = Math.floor(now / bucketMilliseconds) * bucketMilliseconds;
        const selected = [...this.buckets.values()].filter((bucket) => bucket.startedAt >= firstBucket);
        const requests = selected.reduce((sum, bucket) => sum + bucket.requests, 0);
        const totalLatencyMs = selected.reduce((sum, bucket) => sum + bucket.totalLatencyMs, 0);
        const errors4xx = selected.reduce((sum, bucket) => sum + bucket.errors4xx, 0);
        const errors5xx = selected.reduce((sum, bucket) => sum + bucket.errors5xx, 0);
        const histogram = Array.from({ length: latencyBounds.length + 1 }, (_, index) => selected.reduce((sum, bucket) => sum + (bucket.latencyHistogram[index] ?? 0), 0));
        const coverageSeconds = Math.max(1, Math.floor((now - observedStart) / 1000));
        const series = [];
        for (let startedAt = firstBucket; startedAt <= lastBucket; startedAt += bucketMilliseconds) {
            const bucket = this.buckets.get(startedAt);
            series.push({
                startedAt: new Date(startedAt).toISOString(),
                requests: bucket?.requests ?? 0,
                averageLatencyMs: bucket?.requests
                    ? rounded(bucket.totalLatencyMs / bucket.requests)
                    : null,
                errors4xx: bucket?.errors4xx ?? 0,
                errors5xx: bucket?.errors5xx ?? 0,
            });
        }
        return {
            window,
            bucketSeconds: bucketMilliseconds / 1000,
            generatedAt: new Date(now).toISOString(),
            observedSince: new Date(observedStart).toISOString(),
            coverageSeconds,
            uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
            requests,
            requestsPerSecond: rounded(requests / coverageSeconds, 3),
            latencyMs: {
                average: requests ? rounded(totalLatencyMs / requests) : null,
                p50: percentile(histogram, requests, 0.5),
                p95: percentile(histogram, requests, 0.95),
            },
            errors: { client: errors4xx, server: errors5xx },
            series,
        };
    }
}
