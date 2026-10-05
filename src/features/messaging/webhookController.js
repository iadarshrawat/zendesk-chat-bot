import { enqueueEvents, eligibleEvents } from "./inboxRepository.js";
import { notifyInbox } from "../../runtime/background.js";

export async function handleSunshineMessage(req, res) {
  try {
    const events = eligibleEvents(req.body?.events);
    await enqueueEvents(events, process.env.SUNSHINE_APP_ID);

    // 200 confirms acceptance into this process's memory only. A restart
    // before processing loses queued events.
    res.status(200).json({ received: true });
    if (events.length) {
      notifyInbox();
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(400).json({ error: error.message });
    }

    console.error("Webhook queue failed", { code: error.code, message: error.message });
    res.status(503).json({ error: "Webhook could not be queued" });
  }
}
