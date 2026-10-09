// js/: dashboard behavior. This entry file connects the form, API, display, and exports.
import { renderDashboard, setupDashboard } from "./dashboard.js";
import { formatTimestamp } from "./formatters.js";
import {
  fetchMonitoringPage,
  fetchMonitoringIssues,
  maxRangeDate,
  monitoringApiErrorMessage,
  validateDateRange,
} from "./monitoringApi.js";
import {
  fetchExportSessions,
  downloadMonitoringWorkbook,
} from "./excelExport.js";
import { downloadDashboardPdf } from "./pdfExport.js";

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
};

// Keep the displayed page and the last successful search separate from form edits.
const state = {
  client: null,
  sessions: [],
  filters: null,
  pagePositions: [{ cursor: null }],
  nextPagePosition: null,
  page: 1,
  loaded: false,
  activity: null, // null, "search", "issues", "excel", or "pdf"; one operation at a time.
  activeTab: "sessions",
  issues: [],
  issueTotal: 0,
  issuesLoaded: false,
  issuesError: "",
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
  elements.report.setAttribute("aria-busy", String(busy));
  elements.refreshButton.disabled = busy || !state.loaded;
  elements.searchButton.disabled = busy || !state.client;
  elements.clearFiltersButton.disabled = busy;
  elements.excelButton.disabled = busy || !state.loaded;
  elements.pdfButton.disabled = busy || !state.loaded;
  elements.previousPageButton.disabled =
    busy || !state.loaded || state.page <= 1;
  elements.nextPageButton.disabled =
    busy || !state.loaded || !state.nextPagePosition;
  elements.sessionsTab.disabled = busy && state.activity !== "issues";
  elements.issuesTab.disabled = busy && state.activity !== "issues";
  elements.retryIssuesButton.disabled = busy;
  elements.refreshButton.textContent =
    state.activity === "search" ? "Loading…" : "Refresh page";
  elements.excelButtonLabel.textContent =
    state.activity === "excel" ? "Exporting…" : "Export Excel";
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
 * Fetch one results page using the supplied or last successful search filters.
 * @returns {Promise<void>} Updates the saved page on success; displays an error on failure.
 */
async function loadPage(page, filters = state.filters) {
  if (!state.client || state.activity) return;
  const error = validateDateRange(filters?.from, filters?.to);
  if (error) {
    showNotice(error);
    return;
  }

  setActivity("search");
  elements.excelStatus.hidden = true;
  elements.pdfStatus.hidden = true;
  elements.syncText.textContent = "Searching monitoring data…";
  clearNotice();

  let searchSucceeded = false;
  try {
    // Page one starts a fresh cursor chain. Later pages use their saved cursor.
    let positions = [{ cursor: null }];
    if (page > 1) positions = state.pagePositions.slice(0, page);
    const result = await fetchMonitoringPage(
      state.client,
      filters,
      positions[page - 1],
    );

    state.sessions = result.sessions;
    state.filters = { ...filters };
    state.pagePositions = positions;
    state.nextPagePosition = result.next;
    state.page = page;
    state.loaded = true;
    state.issues = [];
    state.issueTotal = 0;
    state.issuesLoaded = false;
    state.issuesError = "";
    searchSucceeded = true;
    if (result.next) state.pagePositions[page] = result.next;
    elements.syncText.textContent = `Updated ${formatTimestamp(Date.now())}`;
    updateDashboard();
  } catch (error) {
    elements.syncText.textContent = state.loaded
      ? "Last update failed"
      : "Unable to load";
    showNotice(monitoringApiErrorMessage(error));
  } finally {
    setActivity(null);
  }
  if (searchSucceeded && state.activeTab === "issues") await loadIssues();
}

/**
 * Load category counts for every session matching the last successful search.
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
  await loadPage(1, readFilters());
}

/**
 * Fetch the displayed page again with its applied filters.
 * @returns {Promise<void>} Finishes after the refresh request.
 */
async function refreshPage() {
  await loadPage(state.page);
}

/**
 * Fetch the preceding page with its saved cursor and applied filters.
 * @returns {Promise<void>} Finishes after the previous-page request.
 */
async function previousPage() {
  await loadPage(state.page - 1);
}

/**
 * Fetch the following page with its saved cursor and applied filters.
 * @returns {Promise<void>} Finishes after the next-page request.
 */
async function nextPage() {
  await loadPage(state.page + 1);
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
 * Download all sessions matching the last successful search as a plain Excel file.
 * @returns {Promise<void>} Finishes after the download starts or an error is shown.
 */
async function exportExcel() {
  if (!state.loaded || state.activity) return;
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
    const sessions = await fetchExportSessions(
      state.client,
      filters,
      showExportProgress,
    );
    elements.excelStatus.textContent = "Creating Excel file…";
    const result = await downloadMonitoringWorkbook(sessions, filters);
    elements.excelStatus.textContent = `Exported ${result.sessions} sessions for ${filters.from} to ${filters.to}.`;
  } catch (error) {
    elements.excelStatus.hidden = true;
    showNotice(`Excel export failed. ${monitoringApiErrorMessage(error)}`);
  } finally {
    setActivity(null);
  }
}

/**
 * Download the displayed overview and charts as an A4 PDF.
 * @returns {Promise<void>} Finishes after the download starts or an error is shown.
 */
async function exportPdf() {
  if (!state.loaded || state.activity) return;
  const filters = { ...state.filters };
  const page = state.page;
  setActivity("pdf");
  elements.pdfStatus.hidden = false;
  elements.pdfStatus.textContent =
    "Preparing the displayed overview and charts…";
  clearNotice();

  try {
    await downloadDashboardPdf(elements.report, filters, page);
    elements.pdfStatus.textContent = `PDF downloaded for ${filters.from} to ${filters.to} · page ${page}.`;
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
}

/**
 * Connect to Zendesk, prepare the default form, and display the empty dashboard.
 * @returns {void} Initializes the app; results are fetched only after Search.
 */
function initializeApp() {
  state.client = globalThis.ZAFClient?.init() || null;
  resetFilters();
  setupDashboard(openTicket);
  bindEvents();
  updateDashboard();
  if (!state.client) {
    showNotice(
      "Open this app from the Zendesk Support navigation bar to load monitoring data.",
    );
    elements.syncText.textContent = "Zendesk connection unavailable";
  }
}

initializeApp();
