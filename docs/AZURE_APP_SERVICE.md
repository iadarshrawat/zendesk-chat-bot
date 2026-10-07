# Azure App Service: deploy from GitHub

The service runs with one startup command: `npm start`. It verifies the three SQL Server application tables, checks Cosmos, and starts HTTP, in-memory inbox processing, and monitoring. Create the tables separately with the reviewed `npm run db:migrate` command before starting the app. Connect the source repository to Azure once; later GitHub pushes deploy automatically. There is no Azure deployment ZIP or manual ZIP upload.

## First setup

1. Put this project's **contents** in a GitHub repository. `package.json`, `server.js`, `src/`, and `migrations/` belong at the repository root. Keep `.env`, the private `data/seed/` archives, and credentials out of GitHub. Run `npm ci` locally once to work on the code; Azure installs its own dependencies during deployment.
2. Create an Azure App Service for Node.js 20 or newer. Choose an App Service plan with **Always On**, enable it, and use a supported Node.js runtime. Without Always On, Azure may unload the app while idle, delaying the next webhook and pausing background monitoring.
3. Set App Service **Environment variables / App settings** using `.env.example`: SQL Server, Zendesk, Sunshine, Cosmos, Voyage, Anthropic, widget, and brand settings. Confirm the client's existing SQL Server database and `DB_SCHEMA`. Review both SQL migration files, then run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"` with the exact configured `DB_NAME.DB_SCHEMA` and temporary create-table permission. It creates only `bot_conversation_state`, `bot_monitor_sessions`, and `bot_monitor_evaluations` if missing. Normal `npm start` only checks them and should use a login limited to those three tables.
4. In the App Service **Deployment Center**, choose **GitHub**, authorize the repository, select the branch, choose **GitHub Actions** as build provider, and choose **User-assigned identity** when your Azure permissions permit. Azure creates a workflow in GitHub. Check that its deployment includes the project root and installs npm dependencies. Deployments start when you push commits to that branch. [Azure's Deployment Center guide](https://learn.microsoft.com/en-us/azure/app-service/deploy-continuous-deployment) describes the current screens.
5. Set the App Service startup command to `npm start` if your runtime configuration asks for one. After deployment, check the logs for `Microsoft SQL Server connected`, `HTTP server ready`, and `Background processing ready`. Visit `https://<app-name>.azurewebsites.net/health/ready` and expect `{ "status": "ready" }`.
6. Point the Zendesk Conversations webhook at `https://<app-name>.azurewebsites.net/sunshine/webhook`; subscribe to `conversation:create` and `conversation:message` and match its shared secret. Send a test customer question, then inspect `BOT TURN SUMMARY` and `npm run diagnose` output if needed.

For separate staging and production branches, use **two App Services** with separate SQL Server databases and application settings. Connect `staging` to the staging app and `main` to the production app in their respective Deployment Centers. Configure different Zendesk webhook targets so a staging message cannot reach production.

If the same App Service previously ran the `bot-worker` WebJob, stop and remove it during the upgrade. This release runs both background loops inside `npm start`. Run **one app instance**: inbox jobs and forms are process-local and are lost on restart, and scaled-out instances would not share them. A SQL Server application lock ensures only one monitor runs at a time if another instance exists.

## Slow reply after inactivity

Enable **Always On**, then compare `queueDelayMs` and `processingMs` in `BOT TURN SUMMARY`. A high queue delay points to app startup or a backed-up inbox. A high processing time with a low queue delay points to the logged `BOT TRACE` stages for Zendesk, Cosmos, Voyage or Claude. The immediate webhook wakeup eliminates the local 750 ms idle poll wait; it cannot remove remote API latency or model generation time.

## Monitoring cycle

At startup and approximately every five minutes, the monitor requests tickets **updated in the previous five hours**, fetches their conversation logs, splits customer conversations when the next customer message follows at least two hours of inactivity, and scores due sessions using the complete chat through the end of each session. It saves the complete evaluation and its completion marker atomically in SQL Server. Zendesk is used to read ticket conversations, not to store monitoring results. A repeated poll skips that session. Zendesk's incremental export excludes the most recent minute, which is covered by the next poll's overlapping five-hour window.
