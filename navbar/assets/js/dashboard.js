// js/: dashboard behavior. This file displays totals, charts, session rows, and the detail dialog.
import { SATISFACTION_SCORES, summarizeSessions } from "./reportData.js";
import {
  formatIssueType,
  formatLabel,
  formatTimestamp,
  formatValue,
} from "./formatters.js";

const DETAIL_GROUPS = [
  [
    "Evaluation",
    [
      ["Satisfaction score", "score"],
      ["Scoring reason", "reason"],
      ["Monitoring status", "status"],
      ["Key issue", "keyIssue"],
      ["Issue type", "issueType"],
    ],
  ],
  [
    "Ticket",
    [
      ["Ticket ID", "ticketId"],
      ["Subject", "ticketSubject"],
      ["Created at", "ticketCreatedAt"],
      ["Requester ID", "ticketRequesterId"],
    ],
  ],
  [
    "Session timeline",
    [
      ["Session number", "sessionNumber"],
      ["Started at", "sessionStartedAt"],
      ["Last message at", "sessionLastMessageAt"],
      ["Last customer message at", "sessionLastCustomerAt"],
      ["Evaluation due at", "evaluationDueAt"],
      ["Evaluated at", "evaluatedAt"],
      ["Report date", "reportDate"],
      ["Message count", "sessionMessageCount"],
      ["First message ID", "sessionFirstMessageId"],
    ],
  ],
  [
    "Session identity",
    [
      ["Session ID", "sessionId"],
      ["Updated at", "updatedAt"],
    ],
  ],
];

const elements = {
  rangeLabel: document.getElementById("range-label"),
  totalTickets: document.getElementById("total-tickets"),
  satisfiedTickets: document.getElementById("satisfied-tickets"),
  totalSessions: document.getElementById("total-sessions"),
  satisfactionPercent: document.getElementById("satisfaction-percent"),
  ticketBreakdownTotal: document.getElementById("ticket-breakdown-total"),
  sessionBreakdownTotal: document.getElementById("session-breakdown-total"),
  ticketBreakdown: document.getElementById("ticket-score-breakdown"),
  sessionBreakdown: document.getElementById("session-score-breakdown"),
  recordsSummary: document.getElementById("records-summary"),
  recordsHeading: document.getElementById("records-heading"),
  recordsBody: document.getElementById("records-body"),
  emptyState: document.getElementById("empty-state"),
  emptyMessage: document.getElementById("empty-message"),
  pagination: document.getElementById("pagination"),
  pageSummary: document.getElementById("page-summary"),
  detailBackdrop: document.getElementById("detail-backdrop"),
  detailTitle: document.getElementById("detail-title"),
  detailBody: document.getElementById("detail-body"),
  closeDetailButton: document.getElementById("close-detail"),
  sessionsTab: document.getElementById("sessions-tab"),
  issuesTab: document.getElementById("issues-tab"),
  sessionsPanel: document.getElementById("sessions-panel"),
  issuesPanel: document.getElementById("issues-panel"),
  issuesSummary: document.getElementById("issues-summary"),
  issuesBody: document.getElementById("issues-body"),
  issuesEmpty: document.getElementById("issues-empty"),
  retryIssues: document.getElementById("retry-issues"),
};
let focusedBeforeDetail = null;
let openTicket = null; // Assigned during setup; app.js handles Zendesk navigation.

/**
 * Create an element using plain text so API values cannot become HTML.
 * @returns {HTMLElement} The new element, ready to append to the page.
 */
function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Create the colored label for a session satisfaction score.
 * @returns {HTMLElement} A badge containing the readable score label.
 */
function createScoreBadge(score) {
  const tone = SATISFACTION_SCORES.includes(score)
    ? `tone-${score}`
    : "tone-unknown";
  return createTextElement("span", `status-badge ${tone}`, formatLabel(score));
}

/**
 * Display one bar and count for each satisfaction score.
 * @returns {void} Replaces the chart contents in the supplied container.
 */
function renderBreakdown(container, counts, total) {
  const rows = [];
  for (const score of SATISFACTION_SCORES) {
    const count = counts[score] || 0;
    const row = createTextElement("div", "breakdown-row", "");
    const labels = createTextElement("div", "breakdown-labels", "");
    labels.append(
      createTextElement("span", "breakdown-name", formatLabel(score)),
      createTextElement("strong", "breakdown-count", String(count)),
    );
    const track = createTextElement("div", "bar-track", "");
    const fill = createTextElement("span", `bar-fill tone-${score}`, "");
    fill.style.width = `${total ? (count / total) * 100 : 0}%`;
    track.setAttribute("role", "meter");
    track.setAttribute("aria-label", formatLabel(score));
    track.setAttribute("aria-valuenow", String(count));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(total));
    track.append(fill);
    row.append(labels, track);
    rows.push(row);
  }
  container.replaceChildren(...rows);
}

/**
 * Display the selected session and move keyboard focus into its detail dialog.
 * @returns {void} Opens the dialog and remembers the previously focused control.
 */
function openDetail(session) {
  focusedBeforeDetail = document.activeElement;
  elements.detailTitle.textContent = `Ticket #${session.ticketId} · session ${session.sessionNumber}`;
  elements.detailBody.replaceChildren();

  const overview = createTextElement("div", "detail-overview", "");
  const ticketButton = createTextElement(
    "button",
    "button button-secondary",
    "Open ticket in Zendesk ↗",
  );
  ticketButton.type = "button";
  ticketButton.addEventListener("click", () => openTicket(session.ticketId));
  overview.append(createScoreBadge(session.score), ticketButton);
  elements.detailBody.append(overview);

  for (const [heading, fields] of DETAIL_GROUPS) {
    const section = createTextElement("section", "detail-section", "");
    const grid = createTextElement("dl", "detail-grid", "");
    section.append(createTextElement("h3", "", heading));
    for (const [label, key] of fields) {
      const item = createTextElement("div", "detail-item", "");
      const value =
        key === "issueType"
          ? formatIssueType(session[key])
          : key.endsWith("At")
            ? formatTimestamp(session[key])
            : formatValue(session[key]);
      item.append(
        createTextElement("dt", "", label),
        createTextElement("dd", "", value),
      );
      grid.append(item);
    }
    section.append(grid);
    elements.detailBody.append(section);
  }

  elements.detailBackdrop.hidden = false;
  document.body.classList.add("detail-open");
  elements.closeDetailButton.focus();
}

/**
 * Hide the detail dialog and return focus to the control that opened it.
 * @returns {void} Restores the dashboard scroll and keyboard focus.
 */
function closeDetail() {
  elements.detailBackdrop.hidden = true;
  document.body.classList.remove("detail-open");
  focusedBeforeDetail?.focus();
}

/**
 * Build a table row with ticket navigation and details for each displayed session.
 * @returns {void} Replaces the table body with the new rows.
 */
function renderRows(sessions) {
  const rows = [];
  for (const session of sessions) {
    const row = document.createElement("tr");
    const ticketCell = createTextElement("td", "ticket-cell", "");
    const ticketLink = createTextElement(
      "button",
      "ticket-link",
      `#${session.ticketId}`,
    );
    ticketLink.type = "button";
    ticketLink.addEventListener("click", () => openTicket(session.ticketId));
    ticketCell.append(
      ticketLink,
      createTextElement(
        "span",
        "ticket-subject",
        session.ticketSubject || "No subject",
      ),
    );

    const sessionCell = createTextElement("td", "", "");
    sessionCell.append(
      createTextElement(
        "strong",
        "session-number",
        `Session ${session.sessionNumber}`,
      ),
      createTextElement(
        "span",
        "cell-secondary",
        formatTimestamp(session.sessionStartedAt),
      ),
    );
    const scoreCell = document.createElement("td");
    scoreCell.append(createScoreBadge(session.score));
    const dateCell = createTextElement(
      "td",
      "date-cell",
      formatTimestamp(session.evaluatedAt),
    );
    const actionCell = createTextElement("td", "action-cell", "");
    const detailButton = createTextElement(
      "button",
      "view-button",
      "View details",
    );
    detailButton.type = "button";
    detailButton.setAttribute(
      "aria-label",
      `View ticket ${session.ticketId} session ${session.sessionNumber} details`,
    );
    detailButton.addEventListener("click", () => openDetail(session));
    actionCell.append(detailButton);
    row.append(ticketCell, sessionCell, scoreCell, dateCell, actionCell);
    rows.push(row);
  }
  elements.recordsBody.replaceChildren(...rows);
}

/**
 * Display page totals, satisfaction charts, session rows, and pagination labels.
 * @returns {void} Updates the dashboard using the supplied saved page state.
 */
export function renderDashboard(state) {
  const { sessions, filters, page, loaded } = state;
  const summary = summarizeSessions(sessions);
  elements.totalTickets.textContent = String(summary.tickets);
  elements.satisfiedTickets.textContent = String(summary.satisfiedTickets);
  elements.totalSessions.textContent = String(summary.sessions);
  elements.satisfactionPercent.textContent =
    summary.estimatedSatisfactionPercent == null
      ? "—"
      : `${summary.estimatedSatisfactionPercent}%`;
  elements.ticketBreakdownTotal.textContent = `${summary.tickets} tickets`;
  elements.sessionBreakdownTotal.textContent = `${summary.sessions} sessions`;
  elements.rangeLabel.textContent = filters
    ? `${filters.from} → ${filters.to} (report date · page ${page})`
    : "Choose a report date range";
  renderBreakdown(
    elements.ticketBreakdown,
    summary.ticketScores,
    summary.tickets,
  );
  renderBreakdown(
    elements.sessionBreakdown,
    summary.sessionScores,
    summary.sessions,
  );
  renderRows(sessions);
  elements.emptyState.hidden = sessions.length > 0;
  elements.pagination.hidden = !loaded || (sessions.length === 0 && page === 1);
  elements.pageSummary.textContent = `Page ${page} · ${sessions.length} sessions`;
  elements.recordsSummary.textContent = loaded
    ? `${sessions.length} completed sessions on this page · results are fetched from the monitoring API when you search or change pages`
    : "Select dates and click Search to see monitored sessions.";
  elements.emptyMessage.textContent = loaded
    ? "No completed AI sessions match this search. Try different dates or keywords."
    : "The dashboard has not searched monitoring data yet.";
  renderCommonIssues(state);
  showDirectoryTab(state.activeTab);
}

/**
 * Show the selected directory view and update its accessible tab state.
 * @returns {void} Toggles panel visibility and the selected tab's keyboard position.
 */
function showDirectoryTab(tab) {
  const showIssues = tab === "issues";
  elements.recordsSummary.hidden = showIssues;
  elements.recordsHeading.textContent = showIssues
    ? "Common issues"
    : "Tickets and sessions";
  elements.sessionsPanel.hidden = showIssues;
  elements.issuesPanel.hidden = !showIssues;
  elements.sessionsTab.setAttribute("aria-selected", String(!showIssues));
  elements.issuesTab.setAttribute("aria-selected", String(showIssues));
  elements.sessionsTab.tabIndex = showIssues ? -1 : 0;
  elements.issuesTab.tabIndex = showIssues ? 0 : -1;
}

/**
 * Display issue categories in descending frequency for the full applied search.
 * @returns {void} Updates the issue table, its scope message, and loading or error state.
 */
function renderCommonIssues(state) {
  const rows = [];
  for (const issue of state.issues) {
    const row = document.createElement("tr");
    row.append(
      createTextElement("td", "issue-name", formatIssueType(issue.issue_type)),
      createTextElement("td", "issue-count", String(issue.session_count)),
      createTextElement("td", "issue-share", `${issue.percentage}%`),
    );
    rows.push(row);
  }
  elements.issuesBody.replaceChildren(...rows);
  elements.issuesEmpty.hidden = !state.issuesLoaded || state.issues.length > 0;
  elements.retryIssues.hidden = !state.issuesError;
  if (state.activity === "issues") {
    elements.issuesSummary.textContent =
      "Loading common issues for the applied search…";
  } else if (state.issuesError) {
    elements.issuesSummary.textContent = state.issuesError;
  } else if (state.issuesLoaded) {
    elements.issuesSummary.textContent = `${state.filters.from} → ${state.filters.to} · ${state.issueTotal} matching sessions across all pages · one primary issue per session`;
  } else {
    elements.issuesSummary.textContent =
      "Search monitoring sessions, then open this tab to see the most common issues.";
  }
}

/**
 * Close the detail dialog when the user clicks the backdrop outside its content.
 * @returns {void} Hides the dialog only for a backdrop click.
 */
function handleBackdropClick(event) {
  if (event.target === elements.detailBackdrop) closeDetail();
}

/**
 * Close the detail dialog with Escape and keep Tab focus inside it.
 * @returns {void} Updates keyboard focus or closes the dialog.
 */
function handleDialogKeydown(event) {
  if (elements.detailBackdrop.hidden) return;
  if (event.key === "Escape") {
    closeDetail();
    return;
  }
  if (event.key !== "Tab") return;

  const buttons = elements.detailBackdrop.querySelectorAll(
    "button:not(:disabled)",
  );
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Register the ticket-opening handler and the detail dialog's event listeners.
 * @returns {void} Prepares the dialog once when app.js initializes the dashboard.
 */
export function setupDashboard(ticketHandler) {
  openTicket = ticketHandler;
  elements.closeDetailButton.addEventListener("click", closeDetail);
  elements.detailBackdrop.addEventListener("click", handleBackdropClick);
  document.addEventListener("keydown", handleDialogKeydown);
}
