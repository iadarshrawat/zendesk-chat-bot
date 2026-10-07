# Deployment and operations

## Deployment sequence

1. Provision Microsoft SQL Server or Azure SQL reachable from the app process, a Cosmos DB for NoSQL account with vector search enabled, and your Zendesk and model-provider credentials. Restrict database access and store secrets in your hosting provider's application settings.
2. Run `npm ci` to install dependencies. Create the SQL Server database and the schema named by `DB_SCHEMA` (default `dbo`) beforehand. Review `DB_NAME` and `DB_SCHEMA`, then run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"`, replacing the quoted value with the exact configured `DB_NAME.DB_SCHEMA`. The command refuses to connect without the match. The migration creates only `bot_conversation_state`, `bot_monitor_sessions`, and `bot_monitor_evaluations` when missing; it never changes unrelated tables. `npm start` verifies all three tables and fails if any is missing or incompatible; it does not run a migration.
3. Validate both knowledge archives, then ingest each brand only into its matching partition. Confirm Cosmos is configured for 1024-dimensional vectors with the matching Voyage model, or change both together before initial publication.
4. Run `npm start` as the continuously managed app process. It runs HTTP, inbox and monitoring together. On Azure App Service, connect GitHub for automatic deployment, enable Always On and stop/remove any `bot-worker` WebJob from older deployments. See [Azure App Service setup](AZURE_APP_SERVICE.md).
5. Create a Sunshine Conversations webhook for `conversation:create` and `conversation:message`; configure its shared secret and expected app ID. The endpoint is `/sunshine/webhook`. Configure widget `brandId` mappings for both sites.
6. Configure the site's existing authenticated session verifier for `/sunshine/auth`, then call `zE('messenger', 'loginUser', callback => ...)` only after obtaining a Zendesk JWT from that endpoint. Use HTTPS and exact `ALLOWED_ORIGINS` values.
7. Set `REPORT_API_KEY` for report consumers and test `/sunshine/report` with a date range. Monitoring saves complete results only in SQL Server. The temporary navbar build uses a hardcoded connection in `navbar/assets/monitoringConfig.js`. Import existing history with `npm run monitor:import`.
8. Smoke-test a new conversation, a factual question, a follow-up, a form submission, an office-hours handoff, an after-hours handoff, an authenticated user, and a due monitoring window on staging. Use `npm run monitor:preview -- --ticket <id> --inspect` to inspect a real ticket without waiting for the two-hour monitoring deadline or writing a score. Move production only after these account-dependent checks pass.

The original archive did not contain deploy credentials or a website session-verification implementation. `/sunshine/auth` returns 503 until the website JWKS and Zendesk signing key are configured.

## Background processing

- The webhook validates supported events and accepts them into the current process's memory. Active and recently completed event IDs suppress duplicate deliveries while that process stays alive. It returns 503 when the bounded queue is full so Zendesk can retry. A 200 response means the event is in memory, not durable storage.
- Accepted events wake the local inbox loop immediately. The loop also polls every 750 ms while idle. It handles one eligible job at a time, keeps earlier events for the same conversation ahead of later ones, and renews a 120-second processing lease.
- Pre-delivery failures retry with bounded delay for up to five attempts. A network timeout or 5xx after a Sunshine message POST enters `delivery_uncertain` because the message might have arrived. Terminal outcomes remain only in a bounded recent-count snapshot; the full job is no longer available for database requeue.
- Restarting or redeploying the process loses pending and processing jobs, recent duplicate IDs, and unconfirmed escalation forms. A provider retry can restore an event only if Zendesk actually sends it again. Review the Sunshine conversation before manually repeating a customer-visible send.
- The monitor uses a SQL Server application lock to prevent concurrent runs. Each poll starts a fresh Zendesk export with a five-hour lookback, follows that poll's pagination cursor, and fetches conversation logs for tickets updated in the window. It stores full evaluations in `bot_monitor_evaluations` with completed IDs in `bot_monitor_sessions`, in one SQL transaction. Monitor and inbox loops execute independently.

## Inspect and recover

Run `npm run diagnose` on the same host as the app. It calls the report-key-protected `/sunshine/inbox` endpoint on the local process and shows aggregate `pending`, `processing`, `failed`, and `delivery_uncertain` counts. It does not expose job payloads. For `delivery_uncertain`, inspect the Sunshine conversation before deciding whether any customer-visible action needs repeating. For `failed`, inspect the application logs and fix the underlying service or configuration error. There is no inbox SQL row to update or requeue.

Keep an alert on growing active inbox counts, recent failures, `/health/ready`, and process liveness. `/health/ready` checks SQL Server connectivity with `SELECT 1`; it does not check inbox durability. Escalation forms expire from process memory after 30 minutes. No form cleanup query is required.

## Monitoring meaning

- A session starts with a customer message. A customer message at least **two hours** after the previous customer message starts another session. Bot or agent messages do not reset this customer inactivity clock.
- `evaluation_due_at` is two hours after the last customer message in that session. The monitor loop starts about every five minutes, so evaluation can occur a few minutes later. Zendesk's incremental export omits the latest minute; the next overlapping poll includes it.
- `satisfied`, `neutral`, `unsatisfied`, `escalated`, and `insufficient_data` are local report classes. A human-handled session is excluded from the bot's inferred score. The model judges satisfaction from the conversation; its result does not update native Zendesk CSAT.
- Results use a v2 key made from ticket ID and first customer message ID, separate from old five-hour v1 records. Before calling the LLM, the monitor checks SQL Server completed session IDs. It never deliberately rescores a completed session. A new session in the same ticket gets a new record.
- The five-hour ticket lookback is strict: a ticket not updated in that period is not fetched. If the app is down for more than five hours, a missed session is discovered only if that ticket receives another update; there is no historical backfill in this mode. Earlier chat messages for a selected ticket are still included as context for a due session, without later outcomes leaking backward.

To see which sessions have finished, query SQL Server. Replace `dbo` if `DB_SCHEMA` is set:

```sql
SELECT TOP (50) ticket_id, session_id, session_started_at, last_customer_at, evaluated_at
FROM [dbo].[bot_monitor_sessions] ORDER BY evaluated_at DESC;
```

An existing `.env` may still contain `MONITOR_SESSION_IDLE_HOURS` or `MONITOR_LOOKBACK_HOURS` from an older release. The new monitor uses the requested fixed two-hour gap and five-hour lookback and ignores those old settings.

## Latency controls

The webhook authenticates and queues quickly; customer answer time still depends on the local inbox, escalation classification, history, Cosmos, Voyage and Claude. The same-process wakeup removes the idle polling wait for locally received webhooks; it does not bypass provider latency or App Service cold starts. Keep Azure Always On enabled and compare `queueDelayMs` (enqueue to claim), `processingMs` (claim to answer), `durationMs` (answer generation and delivery after classification) and `ragElapsedMs` in `BOT TURN SUMMARY`, then inspect `BOT TRACE` stages. `RAG_QUERY_PLANNING_ENABLED=false` skips the separate planning model for a faster heuristic path at a possible retrieval-quality cost. Reduce retrieval candidate counts only after comparing supported answer quality. Avoid a second customer-facing “checking” message; this code sends a single substantive reply or a concrete fallback for a normal question.

Normal reply delivery has a 3-second Sunshine allowance and a 4-second delivery reserve. Typing-start runs alongside history and state reads; typing-stop runs after the answer POST, alongside conversation-state persistence. Both cleanup tasks are awaited before the next inbox job. State writes have a separate 1.5-second deadline, capped by the remaining response time, and are never automatically retried. Override these with `BOT_SEND_TIMEOUT_MS`, `BOT_DELIVERY_RESERVE_MS`, `BOT_TYPING_STOP_TIMEOUT_MS`, and `BOT_STATE_SAVE_TIMEOUT_MS`. If `turn.state_save_failed` continues, inspect SQL connection latency and lock waits; a larger allowance does not fix an unavailable database.

Prompt limits default to 10 history messages, 5 knowledge chunks, and 20 products. General catalog and unconstrained selection requests include product identity, category, uses, features and price; prose-only records retain one complete description or summary. Detailed support, specifications and constrained requests retain the full product evidence. `rag.context_compaction.contextFieldsSavedChars` reports characters saved by field selection separately from shared-value compaction. Product and knowledge source labels remain stable.

## Scaling boundaries

Run one app instance for this design. Inbox jobs, duplicate history, and escalation forms are local to one process, so multiple instances do not share them; events in the same conversation could reach different instances. SQL Server case state and monitoring completion records persist, and the monitor application lock prevents concurrent monitoring runs. To scale out safely, first move the inbox and form state into a shared durable store. The knowledge snapshot remains in Cosmos; query embedding cache is per process and can have cold starts after deployment.


## SQL monitoring reports and existing history

Run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"` against the exact configured target. Migration 002 adds `bot_monitor_evaluations` with a foreign key to the existing session metadata table, typed timestamps/dates/counts/flags, score/status constraints, and a report pagination index. It never alters or deletes the old tables. Startup verifies all three application tables and never applies DDL.

After deploying the SQL-only monitor, run `npm run monitor:import -- --confirm-target "YourDatabase.dbo"`. This one-time command reads completed v2 two-hour records from `ticket_csat_scores` and inserts their original evaluation data into SQL. It is safe to rerun: newer historical duplicates win, and newer SQL results are not replaced by older records. Unrelated/pending/v1 records are counted as skipped; malformed completed records are counted separately and cause a nonzero exit. It never modifies or deletes Zendesk records. Repeat the import after stopping any older worker that still writes custom objects.

`GET /sunshine/monitoring/sessions?from=2026-10-01&to=2026-10-06&limit=20` requires `Authorization: Bearer <REPORT_API_KEY>`. Optional `search`, `score`, and `cursor` parameters filter in SQL. Dates are inclusive UTC report dates, with a maximum one-year range and 100 rows per page. The JSON contains `sessions`, page-only `summary`, and `pagination.next_cursor`. Use that cursor with the same filters for the next page. `/sunshine/report` remains an alias. Neither report route reads Zendesk.

The temporary navbar build contains the ngrok hostname and matching `REPORT_API_KEY` in `navbar/assets/monitoringConfig.js` and needs no installation settings. The key is visible in browser source and the ZIP. SQL credentials remain on the backend. See `navbar/README.md` for setup.
