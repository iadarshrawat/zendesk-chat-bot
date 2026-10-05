const FORM_LIFETIME_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function resolveWebUserId(form, selector) {
  return String(selector?.webUserId || form?.webUserId || form?.data?.webUserId || "");
}

function copyForm(form) {
  // Return a copy so callers cannot mutate the stored form by reference.
  return JSON.parse(JSON.stringify(form));
}

export function createFormStore({ now = Date.now } = {}) {
  const formsByConversation = new Map();
  let lastCleanupAt = -Infinity;

  function removeExpiredForms(timestamp) {
    if (timestamp - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = timestamp;

    for (const [conversationId, formsByUser] of formsByConversation) {
      for (const [webUserId, entry] of formsByUser) {
        if (entry.expiresAt <= timestamp) formsByUser.delete(webUserId);
      }
      if (formsByUser.size === 0) formsByConversation.delete(conversationId);
    }
  }

  async function saveForm(conversationId, form = {}, selector = {}) {
    const timestamp = now();
    removeExpiredForms(timestamp);

    const webUserId = resolveWebUserId(form, selector);
    const formDocument = {
      status: form.status || "form_submitted",
      data: form.data || {},
      submittedAt: new Date(form.submittedAt || timestamp).toISOString(),
      initiatedBy: form.initiatedBy || null,
      webUserId: webUserId || null,
    };

    const key = String(conversationId);
    let formsByUser = formsByConversation.get(key);
    if (!formsByUser) {
      formsByUser = new Map();
      formsByConversation.set(key, formsByUser);
    }
    formsByUser.set(webUserId, {
      form: copyForm(formDocument),
      expiresAt: timestamp + FORM_LIFETIME_MS,
    });

    return formDocument;
  }

  async function getForm(conversationId, selector = {}) {
    const timestamp = now();
    removeExpiredForms(timestamp);

    const formsByUser = formsByConversation.get(String(conversationId));
    if (!formsByUser) return null;

    const webUserId = resolveWebUserId(null, selector);
    if (webUserId) {
      const entry = formsByUser.get(webUserId);
      return entry && entry.expiresAt > timestamp ? copyForm(entry.form) : null;
    }

    // When there is no user ID, retain the previous ORDER BY web_user_id DESC behavior.
    let selectedId;
    let selectedEntry;
    for (const [candidateId, entry] of formsByUser) {
      if (entry.expiresAt <= timestamp) continue;
      if (selectedId === undefined || candidateId > selectedId) {
        selectedId = candidateId;
        selectedEntry = entry;
      }
    }
    return selectedEntry ? copyForm(selectedEntry.form) : null;
  }

  async function deleteForm(conversationId, selector = {}) {
    const key = String(conversationId);
    const formsByUser = formsByConversation.get(key);
    if (!formsByUser) return false;

    const webUserId = resolveWebUserId(null, selector);
    if (!webUserId) {
      formsByConversation.delete(key);
      return formsByUser.size > 0;
    }

    const deleted = formsByUser.delete(webUserId);
    if (formsByUser.size === 0) formsByConversation.delete(key);
    return deleted;
  }

  return { saveForm, getForm, deleteForm };
}

const activeStore = createFormStore();

export const saveForm = activeStore.saveForm;
export const getForm = activeStore.getForm;
export const deleteForm = activeStore.deleteForm;
