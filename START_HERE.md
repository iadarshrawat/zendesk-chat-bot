# Start here

This is one complete backend project folder. Run commands from the folder containing `package.json`.

1. Install Node.js 22 or 24, then run `npm ci`.
2. Copy `.env.example` to `.env` and fill in your existing settings. On macOS/Linux use `cp .env.example .env`; on PowerShell use `Copy-Item .env.example .env`. Keep your existing `.env` if you already have one.
3. Run the offline checks:

   ```bash
   npm run check
   npm run knowledge:validate:mr-brand
   npm run knowledge:validate:comfort-zone
   ```

4. For a new database or an upgrade requiring migrations, check the configured SQL Server target with `npm run db:check`. Review `migrations/`, then run `npm run db:migrate -- --confirm-target "YourDatabase.dbo"`, substituting the actual database/schema and optional table prefix. See the detailed setup guide before running it against an existing installation.
5. With your existing Cosmos and Voyage settings configured, publish the MR Brands knowledge folder:

   ```bash
   npm run knowledge:ingest:mr-brand
   ```

   Publish the separate Comfort Zone folder only when you intend to initialize or replace that brand snapshot:

   ```bash
   npm run knowledge:ingest:comfort-zone
   ```

6. Run `npm start`. Test `http://localhost:4000/health/live` and `http://localhost:4000/health/ready` if using the default port.
7. Deploy through your normal backend hosting workflow. Configure the existing Sunshine webhook to use the public HTTPS backend URL ending in `/sunshine/webhook` and the matching webhook secret.
8. Test an existing manual question and an SDS question for item `01259` in the MR Brands widget.

Read [docs/END_TO_END_SETUP.md](docs/END_TO_END_SETUP.md) for the configuration groups, SQL target format, upload behavior, widget authentication, monitoring and deployment steps.

Use [knowledge/mr-brand/products.json](knowledge/mr-brand/products.json) to edit the MR Brands catalog. Put approved SDS files under `knowledge/mr-brand/safety-data-sheets/` and link their exact relative paths in `safetyDataSheetPaths`.

Open [reference/sds/START_HERE.html](reference/sds/START_HERE.html) for all 140 original and extracted safety sheets. Nine files covering `01682`, `01683`, `32061`, `32063` and `CZ12570` remain outside the active knowledge folder until reviewed. The source files and review notes are included.
