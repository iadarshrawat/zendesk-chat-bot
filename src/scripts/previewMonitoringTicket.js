import { previewTicketMonitoring } from "../features/monitoring/monitoringJob.js";

function usage() {
  return "Usage: npm run monitor:preview -- --ticket 5687 [--session 1] [--inspect]";
}

function optionsFromArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--ticket") {
      options.ticketId = args[++index];
    } else if (argument === "--session") {
      options.sessionNumber = Number(args[++index]);
    } else if (argument === "--inspect") {
      options.score = false;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!options.ticketId) {
    throw new Error("Ticket ID is required");
  }

  return options;
}

try {
  const options = optionsFromArgs(process.argv.slice(2));
  const preview = await previewTicketMonitoring(options);
  console.log(JSON.stringify(preview, null, 2));
  console.log("Preview only: no SQL Server or Zendesk records were changed.");
} catch (error) {
  const status = error.response?.status;
  const detail = status
    ? `Zendesk HTTP ${status}`
    : error.code || error.message;
  console.error(`Monitoring preview failed: ${detail}`);
  console.error(usage());
  process.exitCode = 1;
}
