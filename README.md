# Zendesk support platform

A Node.js service for the supplied Mr Brand and Comfort Zone support bot. It receives Sunshine Conversations webhooks, answers from a brand-partitioned Cosmos DB knowledge store using Voyage embeddings and Claude, collects escalation details, passes control to Zendesk Agent Workspace, and evaluates customer satisfaction for sessions separated by two hours of customer inactivity. The satisfaction score is an internal estimate, **not Zendesk's official CSAT**.

## What changed from the supplied archive

| Area | Before | In this project |
| --- | --- | --- |
| Webhook | HTTP 200 before work started in process memory | Authenticate, validate and queue in bounded process memory before HTTP 200 |
| Background work | Per-web-process callback and cron | In-memory inbox and monitor loops run inside `npm start`; a queued webhook wakes the inbox immediately |
| Conversation form | Process-local `Map` | Process-local form store with 30-minute expiry |
| Customer messages | Strings and Sunshine POSTs spread over modules | Wording in `src/lib/message/`, message/form/activity delivery in `src/services/messaging/messages/index.js` |
| Widget JWT | Signed arbitrary request-body identity | Verify website session JWT against JWKS; sign only verified claims |
| Report | Public endpoint | Bearer API key required |
| Monitoring | Old export cursors revisited previous tickets | Every five minutes, check tickets updated in the last five hours; track completed two-hour sessions in SQL Server |
| Structure | Generic controllers, methods, utilities | Controllers, services, models, middlewares, loaders and common helpers, following the reference layout |
| Dead paths | Old search pagination, per-process queue, quick-reply LLM, unused upload test file | Removed |

The archive already used **Cosmos DB + Voyage + Claude**, not the earlier Pinecone + Gemini design. This refactor preserves the archive's provider combination and its evidence validation behavior.

## Layout

```text
index.js                         HTTP server and background processing entry point
src/
  controllers/                   auth, health, messaging and monitoring HTTP handlers
  services/                      messaging, monitoring, RAG, knowledge, escalation and business hours
  models/                        conversation state/forms, inbox, monitoring, knowledge and SQL schema
  middlewares/                   authentication, request validation and HTTP error handling
  routers/index.js               existing endpoint paths and middleware order
  loaders/                       Express assembly and SQL/Cosmos startup
  common/                        shared utilities, feature helpers and scheduled loops
  lib/                           customer messages and support prompts
  config/                        existing environment and brand configuration
  api/                           Zendesk, Sunshine, Anthropic, Voyage and website-key requests
scripts/<command>/index.js       migration, ingestion and operational commands
migrations/                      existing SQL Server migration files
navbar/                          Zendesk navbar monitoring app
data/seed/                       private knowledge archives (ignored by git)
docs/                            existing deployment and operations guides
```

Each backend module uses a named folder containing `index.js`. Its parent `index.js` exports the child modules. For example, `src/middlewares/auth/report/index.js` contains report authentication, and `src/middlewares/auth/index.js` exports it. Internal modules import the specific implementation they use to avoid circular imports.

## Run locally

1. Use Node 20+ and Microsoft SQL Server with a dedicated database login. Copy `.env.example` to `.env` and set `DB_HOST`, `DB_PORT` (normally `1433`), `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_SCHEMA` (default `dbo`). Never commit `.env` or the private knowledge archives to a public repository.
2. Run `npm ci` once. Review migrations 001 through 004, confirm `DB_NAME.DB_SCHEMA`, then run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"`. The command requires an exact target match before connecting. It creates only the four application tables and adds the nullable monitoring issue/intent fields and their constraints. It preserves existing records and unrelated tables. Normal `npm start` verifies storage without running DDL; the application login needs access to the four tables and system-catalog metadata.
3. Validate the supplied knowledge packages without API calls:

   ```bash
   npm run ingest -- --source data/seed/Mr_Brand_RAG_Updated.zip --brand-key mr-brand --validate-only
   npm run ingest -- --source data/seed/Comfort_Zone_RAG_Updated.zip --brand-key comfort-zone --validate-only
   ```

4. Review package ownership, then ingest each brand separately with the same commands without `--validate-only`. This publishes brand snapshots in Cosmos. The Cosmos vector dimension must match the Voyage embedding output dimension. The supplied default is 1024.
5. Run `npm start` in one terminal. It verifies the four SQL Server tables, then starts the API, in-memory inbox processor and monitor together. Configure Zendesk's Conversations webhook for `conversation:create` and `conversation:message`, send it to `POST /sunshine/webhook`, and set the webhook shared secret to `SUNSHINE_WEBHOOK_SECRET`.
6. Connect the website's logged-in user session to `POST /sunshine/auth` as described below. Set `REPORT_API_KEY` for report consumers. The temporary navbar build hardcodes this key and the ngrok hostname in `navbar/assets/js/monitoringConfig.js`; it reads SQL through the API. The navbar folder guide is included in [its entry page](navbar/assets/index.html).

`GET /health/live` checks the HTTP process; `GET /health/ready` checks SQL Server connectivity with `SELECT 1`. Startup verifies brand mappings, the four SQL Server tables, Cosmos and required bot credentials before starting both loops.

The only relational application tables are `bot_conversation_state`, `bot_monitor_sessions`, `bot_monitor_evaluations`, and `bot_monitor_intents`. Forms and the webhook inbox are held in process memory. A restart loses pending inbox events, deduplication history, and forms; multiple app instances do not share them. For this design, run one app instance unless you accept independent queues. If table setup fails, confirm `DB_NAME`/`DB_SCHEMA` and the migration login's permission to create only those four tables. An incompatible existing table causes a safe failure; it is not altered automatically.

If the widget receives no reply, keep `npm start` running, send a fresh test message, then run `npm run diagnose` in another terminal on the same host. It calls the report-key-protected `/sunshine/inbox` route on the local process and prints only aggregate queue counts, not customer text or API keys. An empty queue may mean Zendesk has not delivered a supported event: check the public HTTPS webhook URL ending in `/sunshine/webhook`, its `conversation:message` subscription, App ID, and webhook shared secret. `pending` or `processing` counts mean the in-memory worker has work; inspect the `npm start` logs. A `delivery_uncertain` outcome means retrying the send automatically might duplicate a customer-visible reply. This package retains the working `https://api.smooch.io/v2` Sunshine API endpoint from the attached project.

## Check monitoring connectivity

`ETIMEDOUT` and `ENETUNREACH` during connection setup are network/connectivity failures, not failures of a particular table. Check the configured SQL Server connection with `npm run db:check`. It performs only `SELECT 1` and never creates or reads a table. If it cannot connect, check the SQL Server host/port, firewall or IP allowlist, VPN, and server availability before investigating schema.

## HTTP contract

| Endpoint | Caller | Authentication | Result |
| --- | --- | --- | --- |
| `POST /sunshine/webhook` | Sunshine Conversations | `X-API-Key` shared secret; expected `app.id` | In-memory event enqueue, then `200`; malformed `400`, untrusted `401`, queue failure `503` |
| `POST /sunshine/auth` | Logged-in website | `Authorization: Bearer <website-session-JWT>` | Short-lived Zendesk messaging JWT; body identity ignored |
| `GET /sunshine/monitoring/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD` | Private dashboard/backend | `Authorization: Bearer <REPORT_API_KEY>` | Paginated SQL session rows; date, text, score and cursor filters |
| `GET /sunshine/monitoring/issues?from=YYYY-MM-DD&to=YYYY-MM-DD` | Private dashboard/backend | `Authorization: Bearer <REPORT_API_KEY>` | Specific customer intents ranked by session count across the full date/text/score search; no pagination |
| `GET /health/live` / `/health/ready` | Hosting health probe | None | Liveness / SQL Server connectivity |
| `GET /sunshine/inbox` | Local diagnostic | `Authorization: Bearer <REPORT_API_KEY>` | In-memory inbox counts, no payloads |

The website's JWT must be signed with RS256 and contain `sub`, `iss`, `aud`, and expiration. The optional `name`, `email`, and `email_verified` claims come from the website's verified identity system. Configure its JWKS URL, issuer and audience. `ZENDESK_WIDGET_KEY_ID` and `ZENDESK_WIDGET_JWT_SECRET` are a **different** signing key from Zendesk Admin Center. If your website uses a cookie session or a different token format, adapt `src/middlewares/auth/siteIdentity/index.js` to verify that existing session on the server before issuing the Zendesk token. Do not send user identity in a client-controlled JSON body.

## Key scenarios

The [flowcharts](docs/FLOWS.md) cover welcome, normal and follow-up answers, fallback, escalation, widget authentication, knowledge ingestion, the five-minute monitoring cycle and two-hour sessions, reports, and failed deliveries. The [operations guide](docs/OPERATIONS.md) covers Azure deployment, monitoring and recovery.

For Azure App Service deployment, see [the GitHub deployment steps](docs/AZURE_APP_SERVICE.md). Connect the repository to App Service so GitHub pushes deploy automatically. App Service runs `npm start`; no manual deployment ZIP, separate worker command or WebJob is required. If a previous version installed `bot-worker`, stop and remove that old WebJob when upgrading.

## Customer intents in Common issues

Monitoring extracts one specific customer issue/request from the target session, resolving references with earlier messages. The intent includes a concise name, a product/model when known, and a description. Satisfaction reasons do not determine intent. There is no predefined intent list: Claude compares against every saved intent in bounded batches, reuses a confident equivalent, or creates a new canonical intent. Confirmed causes, observed symptoms, and different known products stay separate.

The catalogue lives in `bot_monitor_intents`; evaluations reference it through `intent_id`. Common issues ranks identified intents across the applied date/text/score search, without an "Intent not identified" group. Its percentages still cover all matching sessions. Pending sessions and conversations without a clear request remain available in the session directory. Session details and plain Excel exports also show the intent. Old `issue_type` values remain for compatibility and are not used for grouping.

The session directory, Common issues ranking, and sessions within an intent show up to 15 results per page using shared Previous/Next controls. Each view keeps its page when switching tabs or returning from session details. Excel exports still include all matching sessions across pages.

After applying migration 004, classify existing/pending sessions with:

```bash
npm run monitor:intents -- --confirm-target "YourDatabase.dbo"
```

This command reads original Zendesk conversations and sends their evidence to Claude. It changes only intent assignment fields, preserves scores/reasons/report dates, and is safe to resume. Sessions whose original evidence is unavailable remain pending. An intent-matching outage also leaves the session pending while its valid satisfaction evaluation is saved; rerun this command to retry. Matching is model-based and conservative, rather than a guaranteed exact semantic equivalence check.

To explicitly revisit **every existing session**, including previously inspected sessions, use the same maintenance command:

```bash
npm run monitor:intents -- --confirm-target "YourDatabase.dbo" --all-sessions
```

It reads sessions saved before the run started, reuses the same extraction/matching logic, and prints progress. Existing valid intents survive missing or unclear evidence. Failures leave original data intact and produce a nonzero exit. History import and intent backfill helpers live beneath their CLI commands in `scripts/`; the application does not load them at startup. Migrations 001 through 004 define the permanent database schema. Full reclassification does not run during `npm start` or `npm run db:migrate`.

## Checks performed on this package

- Run `npm run check` to verify JavaScript syntax without starting the server or connecting to external services.
- Both supplied archives passed `--validate-only`: Mr Brand 89 products, 110 manuals, 8 policies; Comfort Zone 41 products, 40 manuals, 7 policies. Nothing was uploaded to Cosmos.
- API guards were exercised without credentials. Live Zendesk, SQL Server, Cosmos, Voyage, Anthropic, website identity, and end-to-end widget behavior still need validation with your account settings.

## Reference implementations and API contracts

The structure is a feature-oriented adaptation of the supplied code, informed by these **official** projects and documents. No single example repository implements this complete combination:

- [Zendesk Sunshine Conversations API quickstart repository](https://github.com/zendesk/sunshine-conversations-api-quickstart-example) and [API quickstart](https://developer.zendesk.com/documentation/conversations/getting-started/api-quickstart/) for webhook and message patterns.
- [Zendesk Sunshine Conversations OpenAPI specification](https://github.com/zendesk/sunshine-conversations-api-spec) for the webhook secret header and API payloads; [switchboard documentation](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/switchboard/) for the agent handoff.
- [Zendesk messaging user authentication](https://developer.zendesk.com/documentation/conversations/messaging-platform/users/authenticating-users-your-app/) for signing a JWT from a verified website user.
- [Azure Cosmos DB vector search TypeScript sample](https://learn.microsoft.com/en-us/samples/azure-samples/cosmos-db-vector-samples/nosql-vector-search-typescript/) for vector policy and index choices; [Voyage embedding reference](https://docs.voyageai.com/reference/embeddings-api) for 1024-dimensional output.
- [Anthropic TypeScript SDK repository](https://github.com/anthropics/anthropic-sdk-typescript) for the answer and planner client; [Azure App Service Node.js guidance](https://learn.microsoft.com/en-us/azure/app-service/quickstart-nodejs) for hosting the single process.
