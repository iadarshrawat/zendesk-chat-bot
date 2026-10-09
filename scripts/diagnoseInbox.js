import 'dotenv/config';
const reportKey = process.env.REPORT_API_KEY;
const port = Number(process.env.PORT || 4000);

if (!reportKey || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set REPORT_API_KEY and a valid PORT before diagnosing the in-memory inbox.');
  process.exitCode = 1;
} else {
  try {
    // This inspects the local server process, never a database table.
    const response = await fetch(`http://127.0.0.1:${port}/sunshine/inbox`, {
      headers: { Authorization: `Bearer ${reportKey}` },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    console.log('Local in-memory inbox:', await response.json());
  } catch (error) {
    console.error('Could not inspect the local inbox:', error.message);
    process.exitCode = 1;
  }
}
