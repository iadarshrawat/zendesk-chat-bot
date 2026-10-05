import jwt from "jsonwebtoken";

export function generateZendeskJWT(req, res) {
  const secret = process.env.ZENDESK_WIDGET_JWT_SECRET;
  const keyId = process.env.ZENDESK_WIDGET_KEY_ID;

  if (!secret || !keyId) {
    return res.status(503).json({ error: "Widget authentication is not configured" });
  }

  const user = req.siteUser;
  const payload = { scope: "user", external_id: user.sub };

  if (typeof user.name === "string" && user.name.trim()) {
    payload.name = user.name.trim();
  }

  if (typeof user.email === "string" && user.email.trim()) {
    payload.email = user.email.trim();
    payload.email_verified = user.email_verified === true;
  }

  const token = jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "5m", keyid: keyId });
  res.set("Cache-Control", "no-store").json({ token });
}
