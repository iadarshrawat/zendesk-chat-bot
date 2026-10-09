/**
 * Supply Axios cancellation options only when a deadline provides a signal.
 * @param {AbortSignal} signal - Optional cancellation signal.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Array<Object>} Optional arguments for an Axios request.
 */
export function requestOptions(signal, timeoutMs) {
  return signal ? [{ signal, timeout: timeoutMs }] : [];
}
