# Public process telemetry

Date: 2026-09-15. Status: implemented.

CoreCrow exposes `GET /v1/status/summary` for the public status dashboard. The process records only response duration and HTTP status class in bounded, five-minute memory buckets. Public summaries support 1, 6 and 24-hour windows and contain request counts, rate, average/p50/p95 latency, 4xx/5xx totals, process uptime and time-series buckets.

No raw route, tenant identifier, user identifier, IP address, header, query value, request body or response body enters the telemetry collector. This keeps the public contract aggregate-only and prevents operational data from becoming a tenant-data side channel.

Coverage begins when the process starts and is reported explicitly. A restart therefore resets traffic history; CoreCrow does not infer availability for time it did not observe. Durable multi-instance metrics and externally observed uptime require an approved observability backend before the dashboard may claim historical availability percentages.

Latency percentiles use a bounded histogram rather than retaining individual requests. This caps memory independently of traffic volume. SMTP readiness verifies the configured transport connection on the existing 15-second health cache and never sends a message as part of a health check.
