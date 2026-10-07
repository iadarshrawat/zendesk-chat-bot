// js/: PDF export. This file copies the displayed overview and captures it in a fixed portrait A4 layout.
import { validateDateRange } from "./monitoringApi.js";
import { formatLabel } from "./formatters.js";

const REPORT_WIDTH_PX = 720;

/**
 * Copy icon paint styles to the report so the PDF renderer preserves their appearance.
 * @returns {void} Updates the cloned SVG icons without changing the dashboard.
 */
function copySvgStyles(source, report) {
  // Inline SVG paint styles so html2canvas can render each icon independently.
  const originalIcons = source.querySelectorAll("svg");
  const reportWindow = source.ownerDocument.defaultView;
  report.querySelectorAll("svg").forEach((icon, index) => {
    const iconStyle = reportWindow.getComputedStyle(originalIcons[index]);
    icon.setAttribute("width", iconStyle.width);
    icon.setAttribute("height", iconStyle.height);
    const originals = [
      originalIcons[index],
      ...originalIcons[index].querySelectorAll("*"),
    ];
    [icon, ...icon.querySelectorAll("*")].forEach((node, nodeIndex) => {
      const style = reportWindow.getComputedStyle(originals[nodeIndex]);
      for (const property of [
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
      ]) {
        node.setAttribute(property, style.getPropertyValue(property));
      }
    });
  });
}

/**
 * Replace editable form controls with plain text from the last successful search.
 * @returns {void} Shows applied text, dates, and satisfaction filters in the cloned report.
 */
function replaceFilterControls(report, filters) {
  const values = {
    search: filters.search?.trim() || "All text",
    "from-date": filters.from,
    "to-date": filters.to,
    "score-filter": formatLabel(filters.score, "All scores"),
  };
  for (const [id, value] of Object.entries(values)) {
    const control = report.querySelector(`#${id}`);
    const text = report.ownerDocument.createElement("div");
    text.className = "pdf-filter-value";
    text.textContent = value;
    control.replaceWith(text);
  }
}

/**
 * Clone the displayed overview, remove controls and the directory, and apply fixed PDF styles.
 * @returns {HTMLElement} A report copy ready for capture. Throws if the dashboard or dates are invalid.
 */
export function createDashboardReport(source, filters) {
  const error = validateDateRange(filters?.from, filters?.to);
  if (error) throw new Error(error);
  if (!source)
    throw new Error(
      "The dashboard report could not be found. Reload the app and try again.",
    );

  const report = source.cloneNode(true);
  report.removeAttribute("id");
  report.classList.add("pdf-report");
  report.style.setProperty("--pdf-report-width", `${REPORT_WIDTH_PX}px`);
  copySvgStyles(source, report);
  report
    .querySelectorAll(
      ".records-panel, .notice, .pdf-status, .filter-actions, .filter-limit, .field-control svg, button",
    )
    .forEach((element) => element.remove());
  replaceFilterControls(report, filters);
  return report;
}

/**
 * Capture the current page overview and charts as a portrait A4 PDF with 12 mm margins.
 * @returns {Promise<Object>} The download filename after saving. Throws if rendering or downloading fails.
 */
export async function downloadDashboardPdf(source, filters, page = 1) {
  const html2pdf = globalThis.html2pdf;
  if (typeof html2pdf !== "function")
    throw new Error(
      "The PDF library could not load. Reload the app and try again.",
    );
  const report = createDashboardReport(source, filters);
  const fileName = `ai-ticket-monitoring_${filters.from}_to_${filters.to}_page-${page}.pdf`;
  try {
    const worker = html2pdf()
      .set({
        filename: fileName,
        margin: 12,
        image: { type: "png" },
        pagebreak: { mode: [] },
        enableLinks: false,
        html2canvas: {
          scale: 2,
          backgroundColor: "#ffffff",
          windowWidth: REPORT_WIDTH_PX + 40,
          windowHeight: 1200,
          scrollX: 0,
          scrollY: 0,
          logging: false,
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: "portrait",
          compress: true,
        },
      })
      .from(report);
    await worker.toContainer();
    const container = await worker.get("container");
    const overlay = await worker.get("overlay");
    // Anchor capture at the origin; centering changes when Zendesk's iframe is resized.
    Object.assign(overlay.style, {
      width: `${REPORT_WIDTH_PX}px`,
      left: "0",
      right: "auto",
      top: "0",
      bottom: "auto",
      overflow: "visible",
    });
    Object.assign(container.style, {
      width: `${REPORT_WIDTH_PX}px`,
      position: "relative",
      left: "0",
      right: "auto",
      top: "0",
      margin: "0",
    });
    await worker.save();
  } finally {
    // A failed canvas capture can leave html2pdf's invisible overlay behind.
    source.ownerDocument
      .querySelectorAll(".html2pdf__overlay")
      .forEach((overlay) => {
        if (overlay.querySelector(".pdf-report")) overlay.remove();
      });
  }
  return { fileName };
}
