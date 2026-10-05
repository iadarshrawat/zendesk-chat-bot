# AI Ticket Monitoring navbar app

This is a private Zendesk Support `nav_bar` app. It reads completed `ai-monitor:v2:` records from the `ticket_csat_scores` custom object with the signed-in agent's Zendesk permissions. It does not connect to SQL Server, call the report API, create records, or modify tickets.

The dashboard shows completed session records returned by the current Zendesk API page. Counts and satisfaction breakdowns apply **only to the displayed page**, not the entire date range; each ticket's latest session *on that page* determines its ticket score. Filters cover report date, Zendesk's word/prefix text search, and score. Open a row to see the saved ticket/session fields; the ticket link opens the Zendesk ticket. Historical resolution fields remain in Zendesk but are not shown; new monitoring evaluations no longer write them.

## Install in Zendesk

1. Replace the placeholder `author.email` and `author.url` in `manifest.json` with the client's approved app contact details. If you change the manifest, rebuild the ZIP; the included ZIP will not update automatically.
2. Confirm the account has the `ticket_csat_scores` custom object populated by the monitoring worker. Agents viewing the app need permission to list that object's records.
3. From the repository root, run `node --test navbar/tests/*.test.js`. If Zendesk CLI is authenticated, also run `zcli apps:validate navbar` and `zcli apps:package navbar`. Otherwise, create a ZIP from the `navbar` directory with `manifest.json`, `translations/en.json`, and the files in `assets/` at the ZIP root. The prepared package is `navbar/dist/ai-ticket-monitoring.zip`.
4. After the client approves installation, open Zendesk Admin Center → **Apps and integrations** → **Apps** → **Zendesk Support apps** → **Upload private app**. Upload the ZIP, finish the install prompts, and open **AI Ticket Monitoring** from the left navigation bar. Installing the ZIP changes the Zendesk account for its agents, so use the intended test account first.

The app uses the Zendesk Apps Framework SDK and the signed-in agent's session to call the Zendesk custom-object API. No SQL credentials, `REPORT_API_KEY`, or additional installation secret belongs in this folder. Zendesk's nav bar location is declared in `manifest.json`.

Select a start and end report date no more than one calendar year apart, then click **Search** (or press Enter). The default is the last 30 UTC dates. Changing filters alone does not fetch data. **Refresh page** re-fetches the current result page; **Next** and **Previous** request their pages from Zendesk again. The app keeps only the displayed page and a few pagination cursors in browser memory; it does not cache the full monitoring history. It uses Zendesk's filtered-search API in read-only mode, with daily equality filters grouped by month because `report_date` is stored as text and cannot use date-range comparison. A wide, sparse range may therefore require several API requests to reach the first matching page. Search text uses Zendesk word/prefix matching rather than the old local substring matching.

The API can still return older duplicate records for one session across different pages; within each page they are deduplicated. Exact full-range ticket counts and deduplication across every page would require scanning all matching records or a separate reporting service. No SQL tables or Zendesk records are created or changed by this app.

The PNG logos are already included. To regenerate them with `node navbar/tools/generateLogos.js`, install `@napi-rs/canvas` first if it is not available in your local dependencies.
