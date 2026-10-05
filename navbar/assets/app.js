import { summarizeSessions } from "./reportData.js";
import { fetchMonitoringPage, maxRangeDate, validateDateRange } from "./zendeskRecords.js";

const SCORE_ORDER = ["satisfied", "neutral", "unsatisfied", "escalated", "insufficient_data"];
const DETAIL_GROUPS = [
  ["Evaluation", [
    ["Satisfaction score", "score"],
    ["Scoring reason", "reason"],
    ["Monitoring status", "status"],
    ["Key issue", "keyIssue"],
  ]],
  ["Ticket", [
    ["Ticket ID", "ticketId"],
    ["Subject", "ticketSubject"],
    ["Created at", "ticketCreatedAt"],
    ["Requester ID", "ticketRequesterId"],
  ]],
  ["Session timeline", [
    ["Session number", "sessionNumber"],
    ["Started at", "sessionStartedAt"],
    ["Last message at", "sessionLastMessageAt"],
    ["Last customer message at", "sessionLastCustomerAt"],
    ["Evaluation due at", "evaluationDueAt"],
    ["Evaluated at", "evaluatedAt"],
    ["Report date", "reportDate"],
    ["Message count", "sessionMessageCount"],
    ["First message ID", "sessionFirstMessageId"],
  ]],
  ["Record identity", [
    ["Record name", "recordName"],
    ["External ID", "externalId"],
    ["Zendesk record ID", "recordId"],
    ["Record updated at", "updatedAt"],
  ]],
];

const elements = Object.fromEntries([
  "refresh-button", "sync-text", "notice", "search-form", "search-button", "search", "from-date", "to-date",
  "score-filter", "clear-filters", "range-label", "total-tickets",
  "satisfied-tickets", "total-sessions", "satisfaction-percent", "ticket-breakdown-total",
  "session-breakdown-total", "ticket-score-breakdown", "session-score-breakdown",
  "records-summary", "records-body", "empty-state",
  "empty-message", "pagination", "page-summary", "previous-page", "next-page",
  "detail-backdrop", "detail-title", "detail-body", "close-detail",
].map((id) => [id, document.getElementById(id)]));

const state = {
  client: null,
  sessions: [], // Only the currently displayed API page.
  filters: null,
  pageStarts: [{ group: 0, cursor: null }],
  nextPosition: null,
  loaded: false,
  loading: false,
  page: 1,
  focusedBeforeDetail: null,
};

function textNode(tagName, className, value) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function displayLabel(value) {
  if (!value) return "Not recorded";
  return String(value).replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function displayValue(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return value === "" || value == null ? "Not recorded" : String(value);
}

function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("en", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "UTC",
  }).format(date)} UTC`;
}

function showNotice(message, kind = "error") {
  elements.notice.textContent = message;
  elements.notice.className = `notice notice-${kind}`;
  elements.notice.hidden = false;
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

function selectedFilters() {
  return {
    search: elements.search.value,
    from: elements["from-date"].value,
    to: elements["to-date"].value,
    score: elements["score-filter"].value,
  };
}

function defaultDates() {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 29);
  elements["from-date"].value = start.toISOString().slice(0, 10);
  elements["to-date"].value = today.toISOString().slice(0, 10);
}

function updateDateLimit() {
  const from = elements["from-date"].value;
  if (!from) {
    elements["to-date"].removeAttribute("max");
    return;
  }
  elements["to-date"].max = maxRangeDate(from);
}

function renderBreakdown(container, values, order, total) {
  container.replaceChildren();
  for (const key of order) {
    const count = values[key] || 0;
    const row = textNode("div", "breakdown-row", "");
    const heading = textNode("div", "breakdown-labels", "");
    const label = textNode("span", "breakdown-name", displayLabel(key));
    const number = textNode("strong", "breakdown-count", String(count));
    const track = textNode("div", "bar-track", "");
    const fill = textNode("span", `bar-fill tone-${key}`, "");
    fill.style.width = `${total ? (count / total) * 100 : 0}%`;
    track.setAttribute("role", "meter");
    track.setAttribute("aria-label", displayLabel(key));
    track.setAttribute("aria-valuenow", String(count));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(total));
    heading.append(label, number);
    track.append(fill);
    row.append(heading, track);
    container.append(row);
  }
}

function renderMetrics(summary, filters) {
  elements["total-tickets"].textContent = String(summary.tickets);
  elements["satisfied-tickets"].textContent = String(summary.satisfiedTickets);
  elements["total-sessions"].textContent = String(summary.sessions);
  elements["satisfaction-percent"].textContent = summary.estimatedSatisfactionPercent == null
    ? "—" : `${summary.estimatedSatisfactionPercent}%`;
  elements["ticket-breakdown-total"].textContent = `${summary.tickets} tickets`;
  elements["session-breakdown-total"].textContent = `${summary.sessions} sessions`;
  elements["range-label"].textContent = filters
    ? `${filters.from} → ${filters.to} (report date · page ${state.page})`
    : "Choose a report date range";

  renderBreakdown(elements["ticket-score-breakdown"], summary.ticketScores, SCORE_ORDER, summary.tickets);
  renderBreakdown(elements["session-score-breakdown"], summary.sessionScores, SCORE_ORDER, summary.sessions);
}

function scoreBadge(value) {
  const tone = SCORE_ORDER.includes(value) ? `tone-${value}` : "tone-unknown";
  return textNode("span", `status-badge ${tone}`, displayLabel(value));
}

async function openTicket(ticketId) {
  try {
    await state.client.invoke("routeTo", "ticket", ticketId);
  } catch {
    showNotice(`Could not open ticket #${ticketId} in Zendesk.`);
  }
}

function openDetail(session) {
  state.focusedBeforeDetail = document.activeElement;
  elements["detail-title"].textContent = `Ticket #${session.ticketId} · session ${session.sessionNumber}`;
  elements["detail-body"].replaceChildren();

  const overview = textNode("div", "detail-overview", "");
  overview.append(scoreBadge(session.score));
  const ticketButton = textNode("button", "button button-secondary", "Open ticket in Zendesk ↗");
  ticketButton.type = "button";
  ticketButton.addEventListener("click", () => openTicket(session.ticketId));
  overview.append(ticketButton);
  elements["detail-body"].append(overview);

  for (const [heading, entries] of DETAIL_GROUPS) {
    const section = textNode("section", "detail-section", "");
    const grid = textNode("dl", "detail-grid", "");
    section.append(textNode("h3", "", heading));
    for (const [label, key] of entries) {
      const item = textNode("div", "detail-item", "");
      const value = key.endsWith("At") && key !== "reportDate"
        ? formatTimestamp(session[key])
        : displayValue(session[key]);
      item.append(textNode("dt", "", label), textNode("dd", "", value));
      grid.append(item);
    }
    section.append(grid);
    elements["detail-body"].append(section);
  }

  elements["detail-backdrop"].hidden = false;
  document.body.classList.add("detail-open");
  elements["close-detail"].focus();
}

function closeDetail() {
  elements["detail-backdrop"].hidden = true;
  document.body.classList.remove("detail-open");
  state.focusedBeforeDetail?.focus();
}

function renderRows(sessions) {
  elements["records-body"].replaceChildren();
  for (const session of sessions) {
    const row = document.createElement("tr");
    const ticketCell = textNode("td", "ticket-cell", "");
    const ticketLink = textNode("button", "ticket-link", `#${session.ticketId}`);
    ticketLink.type = "button";
    ticketLink.addEventListener("click", () => openTicket(session.ticketId));
    ticketCell.append(ticketLink, textNode("span", "ticket-subject", session.ticketSubject || "No subject"));

    const sessionCell = textNode("td", "", "");
    sessionCell.append(
      textNode("strong", "session-number", `Session ${session.sessionNumber}`),
      textNode("span", "cell-secondary", formatTimestamp(session.sessionStartedAt)),
    );
    const scoreCell = textNode("td", "", "");
    scoreCell.append(scoreBadge(session.score));
    const evaluatedCell = textNode("td", "date-cell", formatTimestamp(session.evaluatedAt));
    const actionCell = textNode("td", "action-cell", "");
    const detailButton = textNode("button", "view-button", "View details");
    detailButton.type = "button";
    detailButton.setAttribute("aria-label", `View ticket ${session.ticketId} session ${session.sessionNumber} details`);
    detailButton.addEventListener("click", () => openDetail(session));
    actionCell.append(detailButton);
    row.append(ticketCell, sessionCell, scoreCell, evaluatedCell, actionCell);
    elements["records-body"].append(row);
  }

  elements["empty-state"].hidden = sessions.length > 0;
  elements["pagination"].hidden = !state.loaded || (sessions.length === 0 && state.page === 1);
  elements["page-summary"].textContent = `Page ${state.page} · ${sessions.length} sessions`;
  elements["previous-page"].disabled = state.page <= 1;
  elements["next-page"].disabled = !state.nextPosition;
}

function render() {
  const summary = summarizeSessions(state.sessions);

  renderMetrics(summary, state.filters);
  renderRows(state.sessions);
  elements["records-summary"].textContent = state.loaded
    ? `${state.sessions.length} completed sessions on this page · results are fetched from Zendesk when you search or change pages`
    : "Select dates and click Search to see monitored sessions.";
  elements["empty-message"].textContent = state.loaded
    ? "No completed AI sessions match this search. Try different dates or keywords."
    : "The dashboard has not searched Zendesk yet.";
}

function requestErrorMessage(error) {
  const status = Number(error?.status || error?.responseJSON?.status);
  if (status === 403) return "Your Zendesk role cannot read the monitoring custom object. Ask an admin to review its access permissions.";
  if (status === 404) return "The ticket_csat_scores custom object was not found in this Zendesk account.";
  if (status === 422) return "Zendesk rejected this search. Try a shorter date range or simpler search text.";
  return "Could not load monitoring records from Zendesk. Check your connection and try again.";
}

async function loadData({ newSearch = false, page = state.page } = {}) {
  if (!state.client || state.loading) return;
  const filters = newSearch ? selectedFilters() : state.filters;
  const validationError = validateDateRange(filters?.from, filters?.to);
  if (validationError) {
    showNotice(validationError);
    return;
  }

  state.loading = true;
  elements["refresh-button"].disabled = true;
  elements["search-button"].disabled = true;
  elements["previous-page"].disabled = true;
  elements["next-page"].disabled = true;
  elements["refresh-button"].textContent = "Loading…";
  elements["sync-text"].textContent = "Searching Zendesk…";
  clearNotice();

  try {
    const pageStarts = newSearch ? [{ group: 0, cursor: null }] : state.pageStarts;
    const position = pageStarts[page - 1];
    const result = await fetchMonitoringPage(state.client, filters, position);
    state.sessions = result.sessions;
    state.filters = filters;
    state.pageStarts = pageStarts;
    state.nextPosition = result.next;
    state.loaded = true;
    state.page = page;
    if (result.next) state.pageStarts[page] = result.next;
    elements["sync-text"].textContent = `Updated ${formatTimestamp(Date.now())}`;
    render();
  } catch (error) {
    elements["sync-text"].textContent = state.loaded ? "Last update failed" : "Unable to load";
    showNotice(requestErrorMessage(error));
  } finally {
    state.loading = false;
    elements["refresh-button"].disabled = !state.loaded;
    elements["search-button"].disabled = false;
    elements["refresh-button"].textContent = "Refresh page";
    renderRows(state.sessions);
  }
}

function bindEvents() {
  elements["search-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    loadData({ newSearch: true, page: 1 });
  });
  elements["from-date"].addEventListener("change", updateDateLimit);
  elements["refresh-button"].addEventListener("click", () => loadData());
  elements["clear-filters"].addEventListener("click", () => {
    elements.search.value = "";
    elements["score-filter"].value = "";
    defaultDates();
    updateDateLimit();
    clearNotice();
  });
  elements["previous-page"].addEventListener("click", () => loadData({ page: state.page - 1 }));
  elements["next-page"].addEventListener("click", () => loadData({ page: state.page + 1 }));
  elements["close-detail"].addEventListener("click", closeDetail);
  elements["detail-backdrop"].addEventListener("click", (event) => {
    if (event.target === elements["detail-backdrop"]) closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements["detail-backdrop"].hidden) closeDetail();
  });
}

defaultDates();
updateDateLimit();
elements["refresh-button"].disabled = true;
bindEvents();
render();
if (globalThis.ZAFClient) {
  state.client = globalThis.ZAFClient.init();
} else {
  showNotice("Open this app from the Zendesk Support navigation bar to load monitoring data.");
  elements["sync-text"].textContent = "Zendesk connection unavailable";
}
