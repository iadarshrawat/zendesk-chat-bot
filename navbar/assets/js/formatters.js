// js/: display helpers. This file formats shared labels, missing values, and UTC timestamps.
const timestampFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const ISSUE_LABELS = {
  product_information: "Product information",
  order_status: "Order status",
  delivery: "Delivery",
  returns_refunds: "Returns and refunds",
  payment: "Payment",
  account: "Account",
  technical_support: "Technical support",
  other: "Other",
  unknown: "Unknown",
};

/**
 * Convert a stored primary issue category to its readable dashboard label.
 * @returns {string} The category label, or Unknown if no supported category is recorded.
 */
export function formatIssueType(value) {
  return Object.hasOwn(ISSUE_LABELS, value) ? ISSUE_LABELS[value] : "Unknown";
}

/**
 * Replace underscores with spaces and capitalize the first letter.
 * @returns {string} A readable label, or the supplied fallback when the value is empty.
 */
export function formatLabel(value, fallback = "Not recorded") {
  if (!value) return fallback;
  const label = String(value).replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Format booleans and missing fields for the session detail dialog.
 * @returns {string} Yes, No, Not recorded, or the original value as text.
 */
export function formatValue(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === "" || value == null) return "Not recorded";
  return String(value);
}

/**
 * Format a date in UTC, using the same date and time style across the dashboard.
 * @returns {string} A UTC timestamp, Not recorded for empty values, or the original invalid date text.
 */
export function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${timestampFormatter.format(date)} UTC`;
}
