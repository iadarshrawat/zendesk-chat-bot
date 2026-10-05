import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export const ZENDESK_CONFIG = {
  subdomain: process.env.ZENDESK_SUBDOMAIN || "",
  clientId: process.env.ZENDESK_CLIENT_ID || "",
  clientSecret: process.env.ZENDESK_CLIENT_SECRET || "",
  baseUrl: process.env.ZENDESK_SUBDOMAIN
    ? `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com`
    : null,
};

function validateZendeskConfig() {
  const required = [
    "ZENDESK_SUBDOMAIN",
    "ZENDESK_CLIENT_ID",
    "ZENDESK_CLIENT_SECRET",
  ];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.warn("⚠️ Zendesk credentials missing - auto-import feature will not work");
    console.warn(`💡 Missing: ${missing.join(", ")}`);
    console.warn(
      "💡 Add to .env file: ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET",
    );
    return false;
  }

  return true;
}

const isConfigured = validateZendeskConfig();
const TOKEN_REFRESH_BUFFER_MS = 30_000;

// This process-local cache is sufficient while the service runs as one instance.
let tokenCache = { accessToken: null, expiresAt: 0 };

function clearTokenCache() {
  tokenCache = { accessToken: null, expiresAt: 0 };
}

function safeTokenRequestError(error) {
  const safeError = new Error("Zendesk service token request failed");
  safeError.name = "ZendeskServiceTokenError";
  if (typeof error?.code === "string") safeError.code = error.code;

  const status = Number(error?.response?.status);
  if (status >= 100 && status <= 599) safeError.status = status;
  return safeError;
}

async function getServiceToken() {
  const tokenIsValid = tokenCache.accessToken
    && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  if (tokenIsValid) {
    return tokenCache.accessToken;
  }

  console.log("🔑 Fetching new Zendesk service token...", `${ZENDESK_CONFIG.baseUrl}/oauth/tokens`);

  try {
    const response = await axios.post(
      `${ZENDESK_CONFIG.baseUrl}/oauth/tokens`,
      {
        grant_type: "client_credentials",
        client_id: ZENDESK_CONFIG.clientId,
        client_secret: ZENDESK_CONFIG.clientSecret,
        scope: "read write",
      },
      { headers: { "Content-Type": "application/json" } },
    );

    console.log("✅ Fetched new Zendesk service token");

    tokenCache = {
      accessToken: response.data.access_token,
      expiresAt: Date.now() + response.data.expires_in * 1_000,
    };

    return tokenCache.accessToken;
  } catch (error) {
    const safeError = safeTokenRequestError(error);
    console.error("❌ TOKEN REQUEST failed:", {
      status: safeError.status,
      code: safeError.code,
    });
    throw safeError;
  }
}

/**
 * Create an API client authenticated with Zendesk's client-credentials grant.
 */
export async function createZendeskClient() {
  try {
    if (!isConfigured) {
      throw new Error(
        "Zendesk credentials not configured. Set ZENDESK_SUBDOMAIN, "
          + "ZENDESK_CLIENT_ID, and ZENDESK_CLIENT_SECRET in .env",
      );
    }

    const token = await getServiceToken();
    const client = axios.create({
      baseURL: `${ZENDESK_CONFIG.baseUrl}/api/v2`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    // Retry once if the cached token expires between requests.
    client.interceptors.response.use(
      (response) => response,
      async (error) => {
        try {
          if (error.response?.status === 401 && !error.config._retried) {
            error.config._retried = true;
            clearTokenCache();
            const newToken = await getServiceToken();
            error.config.headers.Authorization = `Bearer ${newToken}`;
            return axios(error.config);
          }

          return Promise.reject(error);
        } catch (retryError) {
          console.error("❌ Failed to refresh Zendesk token on 401 retry:", retryError.message);
          return Promise.reject(retryError);
        }
      },
    );

    return client;
  } catch (error) {
    console.error("❌ Failed to create Zendesk client:", error.message);
    throw error;
  }
}
