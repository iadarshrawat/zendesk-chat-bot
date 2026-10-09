const FORM_LIFETIME_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function resolveWebUserId(form, selector) {
  return String(selector?.webUserId || form?.webUserId || form?.data?.webUserId || '');
}

function copyForm(form) {
  // Return a copy so callers cannot mutate the stored form by reference.
  return JSON.parse(JSON.stringify(form));
}

/**
 * Create the process-local form store with per-user keys and existing expiry rules.
 * @param {Object} options - Options: now.
 * @returns {Object} The saveForm, getForm, and deleteForm operations.
 */
export function createFormStore({ now = Date.now } = {}) {
  const formsByConversation = new Map();
  let lastCleanupAt = -Infinity;

  /**
   * Remove expired forms at the existing cleanup interval.
   * @param {number} timestamp - Current Unix timestamp in milliseconds.
   * @returns {void} Updates the process-local form store.
   */
  function removeExpiredForms(timestamp) {
    if (timestamp - lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanupAt = timestamp;

    for (const [conversationId, formsByUser] of formsByConversation) {
      for (const [webUserId, entry] of formsByUser) {
        if (entry.expiresAt <= timestamp) {
          formsByUser.delete(webUserId);
        }
      }
      if (formsByUser.size === 0) {
        formsByConversation.delete(conversationId);
      }
    }
  }

  /**
   * Save an independent copy of the customer's escalation form with its existing expiry.
   * @param {string} conversationId - Sunshine conversation ID.
   * @param {Object} form - Captured escalation form.
   * @param {Object} selector - Optional webUserId selecting the customer form.
   * @returns {Promise<Object>} The normalized form document stored for the conversation and user.
   */
  async function saveForm(conversationId, form = {}, selector = {}) {
    const timestamp = now();
    removeExpiredForms(timestamp);

    const webUserId = resolveWebUserId(form, selector);
    const formDocument = {
      status: form.status || 'form_submitted',
      data: form.data || {},
      submittedAt: new Date(form.submittedAt || timestamp).toISOString(),
      initiatedBy: form.initiatedBy || null,
      webUserId: webUserId || null
    };

    const key = String(conversationId);
    let formsByUser = formsByConversation.get(key);
    if (!formsByUser) {
      formsByUser = new Map();
      formsByConversation.set(key, formsByUser);
    }
    formsByUser.set(webUserId, {
      form: copyForm(formDocument),
      expiresAt: timestamp + FORM_LIFETIME_MS
    });

    return formDocument;
  }

  /**
   * Read a non-expired form and return a copy so callers cannot mutate the stored form.
   * @param {string} conversationId - Sunshine conversation ID.
   * @param {Object} selector - Optional webUserId selecting the customer form.
   * @returns {Promise<Object|null>} The selected form, or null when absent or expired.
   */
  async function getForm(conversationId, selector = {}) {
    const timestamp = now();
    removeExpiredForms(timestamp);

    const formsByUser = formsByConversation.get(String(conversationId));
    if (!formsByUser) {
      return null;
    }

    const webUserId = resolveWebUserId(null, selector);
    if (webUserId) {
      const entry = formsByUser.get(webUserId);

      return entry && entry.expiresAt > timestamp ? copyForm(entry.form) : null;
    }

    // When there is no user ID, retain the previous ORDER BY web_user_id DESC behavior.
    let selectedId;
    let selectedEntry;
    for (const [candidateId, entry] of formsByUser) {
      if (entry.expiresAt <= timestamp) {
        continue;
      }
      if (selectedId === undefined || candidateId > selectedId) {
        selectedId = candidateId;
        selectedEntry = entry;
      }
    }

    return selectedEntry ? copyForm(selectedEntry.form) : null;
  }

  /**
   * Delete the selected user's form, or all forms when no user selector was supplied.
   * @param {string} conversationId - Sunshine conversation ID.
   * @param {Object} selector - Optional webUserId selecting the customer form.
   * @returns {Promise<boolean>} Whether a matching form or conversation entry was deleted.
   */
  async function deleteForm(conversationId, selector = {}) {
    const key = String(conversationId);
    const formsByUser = formsByConversation.get(key);
    if (!formsByUser) {
      return false;
    }

    const webUserId = resolveWebUserId(null, selector);
    if (!webUserId) {
      formsByConversation.delete(key);

      return formsByUser.size > 0;
    }

    const deleted = formsByUser.delete(webUserId);
    if (formsByUser.size === 0) {
      formsByConversation.delete(key);
    }

    return deleted;
  }

  return { saveForm, getForm, deleteForm };
}

const activeStore = createFormStore();

export const saveForm = activeStore.saveForm;
export const getForm = activeStore.getForm;
export const deleteForm = activeStore.deleteForm;
