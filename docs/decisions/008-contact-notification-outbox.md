# Durable contact notifications

Date: 2026-09-15. Status: implemented.

Public contact submission remains a database-first operation. The request and a pending notification state are committed together before the API returns `201`. SMTP delivery runs outside the request transaction so a temporary relay failure cannot discard the submitted contact data or make a client retry create misleading delivery guarantees.

The active CoreCrow runtime claims pending notifications with a conditional update, sends a plain-text internal notification, and records an audited `sent` or `failed` transition. Failed deliveries use bounded exponential retries and stop after five attempts. A stale processing claim is released after ten minutes so a process interruption does not strand the request. Stored errors are restricted to a sanitized machine code; SMTP responses and credentials are not persisted.

`CONTACT_NOTIFICATIONS_ENABLED` is disabled for deployment candidates to prevent verification containers from running background work against production. The notification recipient is infrastructure-owned through `CONTACT_NOTIFICATION_TO`; public input can set only the validated reply-to address and message fields. Existing contact rows are marked `not_requested` by the additive migration and are not silently resent.
