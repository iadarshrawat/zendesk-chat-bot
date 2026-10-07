# AI Ticket Monitoring navbar app

This Zendesk Support navbar app reads completed monitoring sessions from the backend SQL report API. The monitor stores session metadata and evaluations only in SQL Server. Zendesk supplies ticket conversations and ticket navigation; the dashboard no longer uses a custom object.

## Temporary hardcoded connection

The current frontend connection is defined in `assets/monitoringConfig.js`:

- Backend hostname: `ungestural-bertha-celestial.ngrok-free.dev`
- Report key: the existing backend `REPORT_API_KEY`, copied from `.env`
- Page size: 20

No Zendesk installation settings are required. The report key is visible in browser source, network requests, and the ZIP in this temporary build. Keep this build private. For a production release, restore Zendesk secure settings and rotate the report key.

Changing `.env` does not update the hardcoded frontend key. If the backend key changes, update `apiKey` in `assets/monitoringConfig.js`. If the ngrok hostname changes, update `hostname` there and `domainWhitelist` in `manifest.json`, then restart the local preview or rebuild the ZIP.

## Run the local preview

1. Keep the backend and ngrok tunnel running. The backend must have the SQL migrations applied and the matching `REPORT_API_KEY` loaded.
2. From the repository root, run `zcli apps:server navbar`. Restart an already running ZCLI server so it loads the updated manifest without the old installation parameters.
3. Open `https://d3v-itbytes.zendesk.com/agent/apps/ai-ticket-monitoring?zcli_apps=true`, reload the page, select dates, and click Search.

Requests use [Zendesk's proxy](https://developer.zendesk.com/documentation/apps/app-developer-guide/making-api-requests-from-a-zendesk-app/#making-a-request-to-a-third-party-api) with `cors: false` and a literal Authorization header. They no longer depend on secure-setting substitution, which ZCLI does not support. The ngrok warning bypass header keeps requests from receiving the free-tunnel browser warning page.

## Upgrade and install

1. Configure the backend SQL connection and `REPORT_API_KEY`. Review migrations 001 and 002, then run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"` against the exact configured `DB_NAME.DB_SCHEMA`.
2. Deploy/restart the updated backend. Preserve any pending inbox work before restarting. Import existing completed two-hour monitoring history with `npm run monitor:import -- --confirm-target "YourDatabase.dbo"`. The import reads the former custom object without modifying it and is safe to rerun. Stop older workers that still write custom objects, then run the import again if needed.
3. Upload `navbar/dist/ai-ticket-monitoring.zip` as an updated private app. This build has its hostname and report key included, so it does not prompt for connection settings.
4. Restrict the installed app to the intended Zendesk agent roles. Open it from the Support navigation bar, select report dates, and click Search.

## API and dashboard behavior

The app requests `GET https://<hostname>/sunshine/monitoring/sessions` with inclusive UTC report dates, optional text/satisfaction filters, and a page size of 20. Search is a literal case comparison according to the SQL database collation across ticket ID, subject, scoring reason and key issue. The backend caps date ranges at one calendar year and pages at 100 rows. Cursor pagination keeps only the displayed page and page positions in browser memory. Refresh, Next and Previous fetch from the API again. Counts and satisfaction percentages describe the displayed page; ticket outcomes use the latest session on that page.

The SQL tables preserve session IDs, ticket metadata, evaluation dates, satisfaction, reason, confidence, flags, key issue and session timing/counts. Older unrelated or five-hour v1 records are not mixed into this two-hour dashboard. Missing optional historical values remain unknown.

## Checks and packaging

Run `node --test navbar/tests/*.test.js`. Remote validation and packaging use `zcli apps:validate navbar` and `zcli apps:package navbar`. Replace the placeholder author contact information in the manifest with the approved contact details before publishing. The ZIP must contain `manifest.json`, `translations/en.json` and `assets/` at its root. This temporary ZIP includes the hardcoded report key.
