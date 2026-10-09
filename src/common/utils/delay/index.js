/**
 * Wait between background retries without borrowing a customer response budget.
 * @param {number} milliseconds - Delay before resolving.
 * @returns {Promise<void>} Resolves after the existing timer delay.
 */
export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
