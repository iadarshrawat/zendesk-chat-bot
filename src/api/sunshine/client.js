import axios from 'axios';

/**
 * Create the app-authenticated Sunshine client using the existing environment credentials.
 * @returns {Object} An Axios client with Basic authentication and the existing timeout.
 */
export function createSunshineClient() {
  const { SUNSHINE_KEY_ID, SUNSHINE_KEY_SECRET, SUNSHINE_APP_ID } = process.env;
  if (!SUNSHINE_KEY_ID || !SUNSHINE_KEY_SECRET || !SUNSHINE_APP_ID) {
    throw new Error('Sunshine Conversations API credentials are missing');
  }

  return axios.create({
    baseURL: 'https://api.smooch.io/v2',
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
    auth: { username: SUNSHINE_KEY_ID, password: SUNSHINE_KEY_SECRET }
  });
}
