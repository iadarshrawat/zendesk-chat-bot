# Zendesk support platform

A Node.js service for the supplied Mr Brand and Comfort Zone support bot. It receives Sunshine Conversations webhooks, answers from a brand-partitioned Cosmos DB knowledge store using Voyage embeddings and Claude, collects escalation details, passes control to Zendesk Agent Workspace, and evaluates customer satisfaction for sessions separated by two hours of customer inactivity. The satisfaction score is an internal estimate, **not Zendesk's official CSAT**.

## What changed from the supplied archive

| Area | Before | In this project |
| --- | --- | --- |
| Webhook | HTTP 200 before work started in process memory | Authenticate, validate and queue in bounded process memory before HTTP 200 |
| Background work | Per-web-process callback and cron | In-memory inbox and monitor loops run inside `npm start`; a queued webhook wakes the inbox immediately |
| Conversation form | Process-local `Map` | Process-local form store with 30-minute expiry |
| Customer messages | Strings and Sunshine POSTs spread over modules | Wording in `customerMessages.js`, message/form/activity delivery in `messageGateway.js` |
| Widget JWT | Signed arbitrary request-body identity | Verify website session JWT against JWKS; sign only verified claims |
| Report | Public endpoint | Bearer API key required |
| Monitoring | Old export cursors revisited previous tickets | Every five minutes, check tickets updated in the last five hours; track completed two-hour sessions in SQL Server |
| Structure | Generic controllers, methods, utilities | Feature modules for messaging, knowledge, monitoring, auth; shared infrastructure |
| Dead paths | Old search pagination, per-process queue, quick-reply LLM, unused upload test file | Removed |

The archive already used **Cosmos DB + Voyage + Claude**, not the earlier Pinecone + Gemini design. This refactor preserves the archive's provider combination and its evidence validation behavior.

## Layout

```text
server.js                        Express API and background processing entry point
src/runtime/background.js        Inbox wakeup, polling recovery and monitoring loops
migrations/001_core.sql          SQL Server state/session metadata migration
migrations/002_monitor_evaluations.sql Full SQL monitoring evaluation schema
src/app.js                       HTTP routes, request guards, health checks
src/config/                     Brand IDs and external-service configuration
src/features/auth/              Website identity, Zendesk JWT and report access
src/features/messaging/         Webhook, in-memory inbox, turn, form, handoff, text and delivery
src/features/knowledge/         Parsing, ingestion, chunking, search, grounding, citations
src/features/monitoring/        Two-hour sessions, evaluation, SQL Server ledger and monitor lock
src/shared/                     Time budgets, retries, timing and bounded SQL
src/scripts/                    Database migration and knowledge ingestion CLI
data/seed/                       Bundled private knowledge archives (ignored by git)
docs/                            Scenario diagrams and operations guide
```

## Run locally

1. Use Node 20+ and Microsoft SQL Server with a dedicated database login. Copy `.env.example` to `.env` and set `DB_HOST`, `DB_PORT` (normally `1433`), `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and `DB_SCHEMA` (default `dbo`). Never commit `.env` or the private knowledge archives to a public repository.
2. Run `npm ci` once. Have the client confirm the target database and schema, review `migrations/001_core.sql` and `migrations/002_monitor_evaluations.sql`, then run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"` with the exact configured `DB_NAME.DB_SCHEMA` and permission to create the three application tables. The command refuses to connect without that match. It can create only `bot_conversation_state`, `bot_monitor_sessions`, and `bot_monitor_evaluations`; it will not modify other tables or create a database/schema. Afterwards, `npm start` verifies these tables but never creates or changes them. The normal app login needs access only to its three tables and system-catalog metadata, not DDL permission.
3. Validate the supplied knowledge packages without API calls:

   ```bash
   npm run ingest -- --source data/seed/Mr_Brand_RAG_Updated.zip --brand-key mr-brand --validate-only
   npm run ingest -- --source data/seed/Comfort_Zone_RAG_Updated.zip --brand-key comfort-zone --validate-only
   ```

4. Review package ownership, then ingest each brand separately with the same commands without `--validate-only`. This publishes brand snapshots in Cosmos. The Cosmos vector dimension must match the Voyage embedding output dimension. The supplied default is 1024.
5. Run `npm start` in one terminal. It verifies the three SQL Server tables, then starts the API, in-memory inbox processor and monitor together. Configure Zendesk's Conversations webhook for `conversation:create` and `conversation:message`, send it to `POST /sunshine/webhook`, and set the webhook shared secret to `SUNSHINE_WEBHOOK_SECRET`.
6. Connect the website's logged-in user session to `POST /sunshine/auth` as described below. Set `REPORT_API_KEY` for report consumers. The temporary navbar build hardcodes this key and the ngrok hostname in `navbar/assets/js/monitoringConfig.js`; it reads SQL through the API. The navbar folder guide is included in [its entry page](navbar/assets/index.html).

`GET /health/live` checks the HTTP process; `GET /health/ready` checks SQL Server connectivity with `SELECT 1`. Startup verifies brand mappings, the three SQL Server tables, Cosmos and required bot credentials before starting both loops.

The only relational application tables are `bot_conversation_state`, `bot_monitor_sessions`, and `bot_monitor_evaluations`. Forms and the webhook inbox are held in process memory. A restart loses pending inbox events, deduplication history, and forms; multiple app instances do not share them. For this design, run one app instance unless you accept independent queues. If table setup fails, confirm `DB_NAME`/`DB_SCHEMA` and the migration login's permission to create only those three tables. An incompatible existing table causes a safe failure; it is not altered automatically.

If the widget receives no reply, keep `npm start` running, send a fresh test message, then run `npm run diagnose` in another terminal on the same host. It calls the report-key-protected `/sunshine/inbox` route on the local process and prints only aggregate queue counts, not customer text or API keys. An empty queue may mean Zendesk has not delivered a supported event: check the public HTTPS webhook URL ending in `/sunshine/webhook`, its `conversation:message` subscription, App ID, and webhook shared secret. `pending` or `processing` counts mean the in-memory worker has work; inspect the `npm start` logs. A `delivery_uncertain` outcome means retrying the send automatically might duplicate a customer-visible reply. This package retains the working `https://api.smooch.io/v2` Sunshine API endpoint from the attached project.

## Test monitoring without waiting or changing client tables

`ETIMEDOUT` and `ENETUNREACH` during connection setup are network/connectivity failures, not failures of a particular table. Check the configured SQL Server connection with `npm run db:check`. It performs only `SELECT 1` and never creates or reads a table. If it cannot connect, check the SQL Server host/port, firewall or IP allowlist, VPN, and server availability before investigating schema.

For a real Zendesk ticket, run `npm run monitor:preview -- --ticket 5687 --inspect` to see whether customer and bot messages are recognized. Omit `--inspect` to score its latest session immediately with Claude; add `--session 1` to select an earlier session. Preview bypasses the normal two-hour wait and five-hour ticket-export window. It reads the ticket and conversation log but makes **no SQL Server connection and no Zendesk record writes**. Scoring sends ticket conversation text to the configured Claude API and does not save the result; `--inspect` does not call Claude.

For an immediate, database-free regression test of session detection, scoring, and the SQL Server ledger query contract, run:

```bash
npm run monitor:test
```

These tests use local Zendesk, Claude, and database fixtures plus a synthetic clock. They do not connect to the client's SQL Server or create tables. A live database integration test still requires an isolated SQL Server database and credentials; do not use the client production database for fixture writes.

## HTTP contract

| Endpoint | Caller | Authentication | Result |
| --- | --- | --- | --- |
| `POST /sunshine/webhook` | Sunshine Conversations | `X-API-Key` shared secret; expected `app.id` | Durable event insert, then `200`; malformed `400`, untrusted `401`, persistence failure `503` |
| `POST /sunshine/auth` | Logged-in website | `Authorization: Bearer <website-session-JWT>` | Short-lived Zendesk messaging JWT; body identity ignored |
| `GET /sunshine/monitoring/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD` | Private dashboard/backend | `Authorization: Bearer <REPORT_API_KEY>` | Paginated SQL session rows; date, text, score and cursor filters |
| `GET /health/live` / `/health/ready` | Hosting health probe | None | Liveness / SQL Server connectivity |
| `GET /sunshine/inbox` | Local diagnostic | `Authorization: Bearer <REPORT_API_KEY>` | In-memory inbox counts, no payloads |

The website's JWT must be signed with RS256 and contain `sub`, `iss`, `aud`, and expiration. The optional `name`, `email`, and `email_verified` claims come from the website's verified identity system. Configure its JWKS URL, issuer and audience. `ZENDESK_WIDGET_KEY_ID` and `ZENDESK_WIDGET_JWT_SECRET` are a **different** signing key from Zendesk Admin Center. If your website uses a cookie session or a different token format, adapt `src/features/auth/siteIdentity.js` to verify that existing session on the server before issuing the Zendesk token. Do not send user identity in a client-controlled JSON body.

## Key scenarios

The [flowcharts](docs/FLOWS.md) cover welcome, normal and follow-up answers, fallback, escalation, widget authentication, knowledge ingestion, the five-minute monitoring cycle and two-hour sessions, reports, and failed deliveries. The [operations guide](docs/OPERATIONS.md) covers Azure deployment, monitoring and recovery.

For Azure App Service deployment, see [the GitHub deployment steps](docs/AZURE_APP_SERVICE.md). Connect the repository to App Service so GitHub pushes deploy automatically. App Service runs `npm start`; no manual deployment ZIP, separate worker command or WebJob is required. If a previous version installed `bot-worker`, stop and remove that old WebJob when upgrading.

## Checks performed on this package

- `npm test` and JS syntax checks passed locally.
- Both supplied archives passed `--validate-only`: Mr Brand 89 products, 110 manuals, 8 policies; Comfort Zone 41 products, 40 manuals, 7 policies. Nothing was uploaded to Cosmos.
- API guards were exercised without credentials. Live Zendesk, SQL Server, Cosmos, Voyage, Anthropic, website identity, and end-to-end widget behavior still need validation with your account settings.

## Reference implementations and API contracts

The structure is a feature-oriented adaptation of the supplied code, informed by these **official** projects and documents. No single example repository implements this complete combination:

- [Zendesk Sunshine Conversations API quickstart repository](https://github.com/zendesk/sunshine-conversations-api-quickstart-example) and [API quickstart](https://developer.zendesk.com/documentation/conversations/getting-started/api-quickstart/) for webhook and message patterns.
- [Zendesk Sunshine Conversations OpenAPI specification](https://github.com/zendesk/sunshine-conversations-api-spec) for the webhook secret header and API payloads; [switchboard documentation](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/switchboard/) for the agent handoff.
- [Zendesk messaging user authentication](https://developer.zendesk.com/documentation/conversations/messaging-platform/users/authenticating-users-your-app/) for signing a JWT from a verified website user.
- [Azure Cosmos DB vector search TypeScript sample](https://learn.microsoft.com/en-us/samples/azure-samples/cosmos-db-vector-samples/nosql-vector-search-typescript/) for vector policy and index choices; [Voyage embedding reference](https://docs.voyageai.com/reference/embeddings-api) for 1024-dimensional output.
- [Anthropic TypeScript SDK repository](https://github.com/anthropics/anthropic-sdk-typescript) for the answer and planner client; [Azure App Service Node.js guidance](https://learn.microsoft.com/en-us/azure/app-service/quickstart-nodejs) for hosting the single process.
