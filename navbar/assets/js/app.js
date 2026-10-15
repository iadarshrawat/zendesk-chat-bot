// js/: dashboard behavior. This entry file connects the form, API, display, and exports.
import { renderDashboard, setupDashboard } from "./dashboard.js";
import { formatTimestamp } from "./formatters.js";
import { displayedPagination, displayedSessionPage } from "./reportData.js";
import {
  fetchMonitoringPage,
  fetchMonitoringSummary,
  fetchMonitoringIssues,
  maxRangeDate,
  monitoringApiErrorMessage,
  validateDateRange,
} from "./monitoringApi.js";
import {
  fetchExportSessions,
  downloadMonitoringWorkbook,
  downloadIntentWorkbook,
} from "./excelExport.js";
import { downloadDashboardPdf } from "./pdfExport.js";
import { configureMonitoringApi } from "./monitoringConfig.js";

const elements = {
  report: document.getElementById("dashboard-report"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search"),
  fromDate: document.getElementById("from-date"),
  toDate: document.getElementById("to-date"),
  scoreFilter: document.getElementById("score-filter"),
  notice: document.getElementById("notice"),
  syncText: document.getElementById("sync-text"),
  refreshButton: document.getElementById("refresh-button"),
  searchButton: document.getElementById("search-button"),
  clearFiltersButton: document.getElementById("clear-filters"),
  excelButton: document.getElementById("export-button"),
  excelButtonLabel: document.getElementById("export-button-label"),
  excelStatus: document.getElementById("export-status"),
  pdfButton: document.getElementById("pdf-button"),
  pdfButtonLabel: document.getElementById("pdf-button-label"),
  pdfStatus: document.getElementById("pdf-status"),
  previousPageButton: document.getElementById("previous-page"),
  nextPageButton: document.getElementById("next-page"),
  sessionsTab: document.getElementById("sessions-tab"),
  issuesTab: document.getElementById("issues-tab"),
  directoryTabs: document.getElementById("directory-tabs"),
  retryIssuesButton: document.getElementById("retry-issues"),
  backToIssuesButton: document.getElementById("back-to-issues"),
};

// Keep the displayed page and the last successful search separate from form edits.
const state = {
  client: null,
  sessions: [],
  summary: null, // Whole-search overview, independent of the visible session page.
  filters: null,
  pagePositions: [{ cursor: null }],
  nextPagePosition: null,
  page: 1,
  loaded: false,
  activity: null, // null, "search", "issues", "excel", or "pdf"; one operation at a time.
  activeTab: "sessions",
  issues: [],
  issuesPage: 1,
  issueTotal: 0,
  issuesLoaded: false,
  issuesError: "",
  intentView: null, // Its session page is separate so the directory keeps its place.
};

/**
 * Show an error or connection message above the filters.
 * @returns {void} Updates the notice on the page.
 */
function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
}

/**
 * Hide the previous error or connection message.
 * @returns {void} Clears the notice on the page.
 */
function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

/**
 * Read the current search text, dates, and satisfaction selection.
 * @returns {Object} The filter values currently entered in the form.
 */
function readFilters() {
  return {
    search: elements.searchInput.value,
    from: elements.fromDate.value,
    to: elements.toDate.value,
    score: elements.scoreFilter.value,
  };
}

/**
 * Reset the form to all scores and the last 30 UTC calendar days.
 * @returns {void} Updates the form without fetching or changing displayed results.
 */
function resetFilters() {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 29);
  elements.searchInput.value = "";
  elements.scoreFilter.value = "";
  elements.fromDate.value = start.toISOString().slice(0, 10);
  elements.toDate.value = today.toISOString().slice(0, 10);
  updateDateLimit();
  clearNotice();
}

/**
 * Limit the end-date picker to one calendar year after the start date.
 * @returns {void} Updates the end-date input's maximum value.
 */
function updateDateLimit() {
  const maxDate = maxRangeDate(elements.fromDate.value);
  if (maxDate) {
    elements.toDate.max = maxDate;
  } else {
    elements.toDate.removeAttribute("max");
  }
}

/**
 * Enable or disable controls and show labels for the current operation.
 * @returns {void} Updates buttons and the report's busy indicator.
 */
function updateActionButtons() {
  const busy = state.activity !== null;
  const isIntentExport = state.activeTab === "issues";
  const pagination = displayedPagination(state);
  elements.report.setAttribute("aria-busy", String(busy));
  elements.refreshButton.disabled = busy || !state.loaded;
  elements.searchButton.disabled = busy || !state.client;
  elements.clearFiltersButton.disabled = busy;
  elements.excelButton.disabled =
    busy ||
    !state.loaded ||
    (isIntentExport && (!state.issuesLoaded || !state.issues.length));
  elements.pdfButton.disabled = busy || !state.loaded;
  elements.previousPageButton.disabled =
    busy || !pagination.loaded || !pagination.hasPrevious;
  elements.nextPageButton.disabled =
    busy || !pagination.loaded || !pagination.hasNext;
  elements.sessionsTab.disabled = busy && state.activity !== "issues";
  elements.issuesTab.disabled = busy && state.activity !== "issues";
  elements.retryIssuesButton.disabled = busy;
  elements.backToIssuesButton.disabled = busy;
  elements.excelButton.title = isIntentExport
    ? state.intentView
      ? "Export this customer intent to Excel"
      : "Export all customer intents matching your latest search to Excel"
    : "Export all sessions matching your latest search to Excel";
  elements.refreshButton.textContent =
    state.activity === "search" ? "Loading…" : "Refresh page";
  elements.excelButtonLabel.textContent =
    state.activity === "excel"
      ? "Exporting…"
      : isIntentExport
        ? "Export intents"
        : "Export Excel";
  elements.pdfButtonLabel.textContent =
    state.activity === "pdf" ? "Creating PDF…" : "Download PDF";
}

/**
 * Mark a search or export as active; pass null when it finishes.
 * @returns {void} Stores the activity and updates the buttons.
 */
function setActivity(activity) {
  state.activity = activity;
  updateActionButtons();
}

/**
 * Display the saved results and update navigation and export controls.
 * @returns {void} Refreshes the dashboard without making an API request.
 */
function updateDashboard() {
  renderDashboard(state);
  updateActionButtons();
}

/**
 * Open a ticket through the Zendesk app SDK and report a navigation failure.
 * @returns {Promise<void>} Finishes when Zendesk handles the navigation request.
 */
async function openTicket(ticketId) {
  try {
    await state.client.invoke("routeTo", "ticket", ticketId);
  } catch {
    showNotice(`Could not open ticket #${ticketId} in Zendesk.`);
  }
}

/**
 * Fetch a directory or intent page through the same API and cursor handling.
 * @param {number} page - Requested page number.
 * @param {Object} target - Saved page state to update; defaults to the visible view.
 * @param {Object} filters - Applied search, defaulting to the target's saved filters.
 * @param {Object} options - refreshSummary refreshes totals when reloading a directory page.
 * @returns {Promise<void>} Updates the saved page on success; displays an error on failure.
 */
async function loadPage(
  page,
  target = displayedSessionPage(state),
  filters = target.filters || state.filters,
  { refreshSummary = false } = {},
) {
  if (!state.client || state.activity) return;
  const error = validateDateRange(filters?.from, filters?.to);
  if (error) {
    showNotice(error);
    return;
  }

  setActivity("search");
  target.error = "";
  updateDashboard();
  elements.excelStatus.hidden = true;
  elements.pdfStatus.hidden = true;
  elements.syncText.textContent = "Searching monitoring data…";
  clearNotice();

  let searchSucceeded = false;
  try {
    // Page one starts a fresh cursor chain. Later pages use their saved cursor.
    let positions = [{ cursor: null }];
    if (page > 1) positions = target.pagePositions.slice(0, page);
    const needsSummary =
      target === state && (page === 1 || refreshSummary || !state.summary);
    const [result, summary] = await Promise.all([
      fetchMonitoringPage(state.client, filters, positions[page - 1]),
      needsSummary
        ? fetchMonitoringSummary(state.client, filters)
        : Promise.resolve(state.summary),
    ]);

    target.sessions = result.sessions;
    target.filters = { ...filters };
    target.pagePositions = positions;
    target.nextPagePosition = result.next;
    target.page = page;
    target.loaded = true;
    if (target === state) {
      state.summary = summary;
      state.intentView = null;
      state.issues = [];
      state.issuesPage = 1;
      state.issueTotal = 0;
      state.issuesLoaded = false;
      state.issuesError = "";
    }
    searchSucceeded = true;
    if (result.next) target.pagePositions[page] = result.next;
    elements.syncText.textContent = `Updated ${formatTimestamp(Date.now())}`;
  } catch (error) {
    target.error = monitoringApiErrorMessage(error);
    elements.syncText.textContent = state.loaded
      ? "Last update failed"
      : "Unable to load";
    showNotice(target.error);
  } finally {
    setActivity(null);
    updateDashboard();
  }
  if (searchSucceeded && target === state && state.activeTab === "issues")
    await loadIssues();
}

/**
 * Open an intent's matching sessions without changing the saved session directory.
 * @param {Object} issue - Clicked intent with its ID, name, product, and total session count.
 * @returns {Promise<void>} Loads page one using the applied dates, text, and score.
 */
async function showIntentSessions(issue) {
  if (!state.loaded || state.activity) return;
  state.intentView = {
    issue,
    filters: { ...state.filters, intent: issue.intent_id ?? "unidentified" },
    sessions: [],
    pagePositions: [{ cursor: null }],
    nextPagePosition: null,
    page: 1,
    loaded: false,
    error: "",
  };
  await loadPage(1);
  elements.backToIssuesButton.focus();
}

/**
 * Return to the cached intent ranking and restore focus to the selected intent.
 * @returns {void} Shows common issues without fetching or resetting the directory page.
 */
function backToIssues() {
  if (state.activity) return;
  const intent = state.intentView?.filters.intent;
  state.intentView = null;
  clearNotice();
  updateDashboard();
  document.querySelector(`[data-intent="${intent}"]`)?.focus();
}

/**
 * Load customer-intent counts for every session matching the last successful search.
 * @returns {Promise<void>} Stores the full-search ranking or shows a retryable error.
 */
async function loadIssues() {
  if (!state.loaded || state.activity || state.issuesLoaded) return;
  setActivity("issues");
  state.issuesError = "";
  updateDashboard();
  try {
    const result = await fetchMonitoringIssues(state.client, {
      ...state.filters,
    });
    state.issues = result.issues;
    state.issueTotal = result.totalSessions;
    state.issuesLoaded = true;
  } catch (error) {
    state.issuesError = monitoringApiErrorMessage(error);
  } finally {
    setActivity(null);
    updateDashboard();
  }
}

/**
 * Switch back to the session directory without fetching another results page.
 * @returns {void} Shows the saved session page and its navigation controls.
 */
function showSessionsTab() {
  if (state.activity && state.activity !== "issues") return;
  state.activeTab = "sessions";
  updateDashboard();
}

/**
 * Open the common-issues view and fetch its ranking when it is not cached.
 * @returns {Promise<void>} Shows issue counts for the current applied search.
 */
async function showIssuesTab() {
  if (state.activity && state.activity !== "issues") return;
  state.activeTab = "issues";
  updateDashboard();
  await loadIssues();
}

/**
 * Support Arrow, Home, and End keys for the two directory tabs.
 * @returns {void} Selects and focuses the requested tab without moving the page.
 */
function handleDirectoryTabsKeydown(event) {
  if (state.activity && state.activity !== "issues") return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const showIssues =
    event.key === "End" ||
    (event.key !== "Home" && state.activeTab === "sessions");
  if (showIssues) {
    showIssuesTab();
    elements.issuesTab.focus();
  } else {
    showSessionsTab();
    elements.sessionsTab.focus();
  }
}

/**
 * Submit a new search from the form, starting at page one.
 * @returns {Promise<void>} Finishes after the first results page is fetched.
 */
async function searchSessions(event) {
  event.preventDefault();
  await loadPage(1, state, readFilters());
}

/**
 * Refresh the active table with its applied filters, preserving its page when possible.
 * @returns {Promise<void>} Finishes after the refresh request.
 */
async function refreshPage() {
  if (state.activity) return;
  if (displayedPagination(state).isIssues) {
    state.issuesLoaded = false;
    await loadIssues();
    return;
  }
  const view = displayedSessionPage(state);
  await loadPage(view.page, view, view.filters || state.filters, {
    refreshSummary: view === state,
  });
}

/**
 * Move the active view by one page using the shared controls.
 * @param {number} direction - Negative one for Previous, or one for Next.
 * @returns {Promise<void>} Updates a cached intent page or loads a session cursor page.
 */
async function changePage(direction) {
  const pagination = displayedPagination(state);
  if (state.activity || !pagination.loaded) return;
  if (direction < 0 ? !pagination.hasPrevious : !pagination.hasNext) return;
  const page = pagination.page + direction;
  if (pagination.isIssues) {
    state.issuesPage = page;
    updateDashboard();
  } else {
    await loadPage(page);
  }
}

/**
 * Show the previous page of the active session or intent list.
 * @returns {Promise<void>} Finishes after the previous-page request.
 */
async function previousPage() {
  await changePage(-1);
}

/**
 * Show the next page of the active session or intent list.
 * @returns {Promise<void>} Finishes after the next-page request.
 */
async function nextPage() {
  await changePage(1);
}

/**
 * Show how many sessions and result pages the Excel export has collected.
 * @returns {void} Updates the Excel progress message.
 */
function showExportProgress(progress) {
  const pageLabel = progress.pages === 1 ? "page" : "pages";
  elements.excelStatus.textContent = `Collected ${progress.sessions} sessions from ${progress.pages} ${pageLabel}…`;
}

/**
 * Export customer intents from Common issues, or all sessions from Session directory.
 * @returns {Promise<void>} Finishes after the download starts or an error is shown.
 */
async function exportExcel() {
  if (!state.loaded || state.activity) return;
  const isIntentExport = state.activeTab === "issues";
  const filters = { ...state.filters };
  setActivity("excel");
  elements.excelStatus.hidden = false;
  elements.excelStatus.textContent = `Preparing Excel for ${filters.from} to ${filters.to}…`;
  clearNotice();

  try {
    if (!globalThis.ExcelJS?.Workbook) {
      throw new Error(
        "The Excel library could not load. Reload the app and try again.",
      );
    }
    if (isIntentExport) {
      const intents = state.intentView
        ? [state.intentView.issue]
        : state.issues;
      elements.excelStatus.textContent = "Creating customer intent Excel file…";
      const result = await downloadIntentWorkbook(intents, filters);
      elements.excelStatus.textContent = `Exported ${result.intents} customer intents for ${filters.from} to ${filters.to}.`;
    } else {
      const sessions = await fetchExportSessions(
        state.client,
        filters,
        showExportProgress,
      );
      elements.excelStatus.textContent = "Creating Excel file…";
      const result = await downloadMonitoringWorkbook(sessions, filters);
      elements.excelStatus.textContent = `Exported ${result.sessions} sessions for ${filters.from} to ${filters.to}.`;
    }
  } catch (error) {
    elements.excelStatus.hidden = true;
    showNotice(`Excel export failed. ${monitoringApiErrorMessage(error)}`);
  } finally {
    setActivity(null);
  }
}

/**
 * Download the full-search overview and charts as an A4 PDF.
 * @returns {Promise<void>} Finishes after the download starts or an error is shown.
 */
async function exportPdf() {
  if (!state.loaded || state.activity) return;
  const filters = { ...state.filters };
  setActivity("pdf");
  elements.pdfStatus.hidden = false;
  elements.pdfStatus.textContent =
    "Preparing the displayed overview and charts…";
  clearNotice();

  try {
    await downloadDashboardPdf(elements.report, filters);
    elements.pdfStatus.textContent = `PDF downloaded for ${filters.from} to ${filters.to}.`;
  } catch (error) {
    elements.pdfStatus.hidden = true;
    showNotice(`PDF export failed. ${error?.message || "Please try again."}`);
  } finally {
    setActivity(null);
  }
}

/**
 * Attach the named handlers for search, dates, pagination, and exports.
 * @returns {void} Registers listeners once when the app starts.
 */
function bindEvents() {
  elements.searchForm.addEventListener("submit", searchSessions);
  elements.fromDate.addEventListener("change", updateDateLimit);
  elements.clearFiltersButton.addEventListener("click", resetFilters);
  elements.refreshButton.addEventListener("click", refreshPage);
  elements.previousPageButton.addEventListener("click", previousPage);
  elements.nextPageButton.addEventListener("click", nextPage);
  elements.excelButton.addEventListener("click", exportExcel);
  elements.pdfButton.addEventListener("click", exportPdf);
  elements.sessionsTab.addEventListener("click", showSessionsTab);
  elements.issuesTab.addEventListener("click", showIssuesTab);
  elements.directoryTabs.addEventListener(
    "keydown",
    handleDirectoryTabsKeydown,
  );
  elements.retryIssuesButton.addEventListener("click", loadIssues);
  elements.backToIssuesButton.addEventListener("click", backToIssues);
}

/**
 * Connect to Zendesk, prepare the default form, and display the empty dashboard.
 * @returns {Promise<void>} Loads connection settings; results are fetched only after Search.
 */
async function initializeApp() {
  const client = globalThis.ZAFClient?.init() || null;
  resetFilters();
  setupDashboard(openTicket, showIntentSessions);
  bindEvents();
  updateDashboard();
  if (!client) {
    showNotice(
      "Open this app from the Zendesk Support navigation bar to load monitoring data.",
    );
    elements.syncText.textContent = "Zendesk connection unavailable";
    return;
  }
  try {
    await configureMonitoringApi(client);
    state.client = client;
  } catch (error) {
    showNotice(monitoringApiErrorMessage(error));
    elements.syncText.textContent = "Connection settings required";
  }
  updateActionButtons();
}

initializeApp();
