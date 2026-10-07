import { validateDateRange } from "./monitoringApi.js";

const REPORT_WIDTH = 720;

/** Copy the displayed overview using its applied search, without changing the app. */
export function createDashboardReport(source, filters) {
  const error = validateDateRange(filters?.from, filters?.to);
  if (error) throw new Error(error);
  if (!source) throw new Error("The dashboard report could not be found. Reload the app and try again.");
  const report = source.cloneNode(true);
  report.removeAttribute("id");
  report.classList.add("pdf-report");
  // Inline SVG paint styles so html2canvas can render each icon independently.
  const originalIcons = source.querySelectorAll("svg");
  report.querySelectorAll("svg").forEach((icon, index) => {
    const iconStyle = source.ownerDocument.defaultView.getComputedStyle(originalIcons[index]);
    icon.setAttribute("width", iconStyle.width);
    icon.setAttribute("height", iconStyle.height);
    const originals = [originalIcons[index], ...originalIcons[index].querySelectorAll("*")];
    [icon, ...icon.querySelectorAll("*")].forEach((node, nodeIndex) => {
      const style = source.ownerDocument.defaultView.getComputedStyle(originals[nodeIndex]);
      for (const property of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]) {
        node.setAttribute(property, style.getPropertyValue(property));
      }
    });
  });
  report.querySelectorAll(".records-panel, .notice, .pdf-status, .filter-actions, .filter-limit, .field-control svg, button").forEach(element => element.remove());
  const score = report.querySelector("#score-filter");
  const scoreLabel = [...score.options].find(option => option.value === filters.score)?.textContent || "All scores";
  const values = {
    search: filters.search?.trim() || "All text",
    "from-date": filters.from,
    "to-date": filters.to,
    "score-filter": scoreLabel,
  };
  for (const [id, value] of Object.entries(values)) {
    const control = report.querySelector(`#${id}`);
    const text = source.ownerDocument.createElement("div");
    text.className = "pdf-filter-value";
    text.textContent = value;
    control.replaceWith(text);
  }
  return report;
}

export async function downloadDashboardPdf(source, filters, {
  html2pdf = globalThis.html2pdf, page = 1,
} = {}) {
  if (typeof html2pdf !== "function") throw new Error("The PDF library could not load. Reload the app and try again.");
  const report = createDashboardReport(source, filters);
  const fileName = `ai-ticket-monitoring_${filters.from}_to_${filters.to}_page-${page}.pdf`;
  try {
    const worker = html2pdf().set({
      filename: fileName,
      margin: 12,
      image: { type: "png" },
      pagebreak: { mode: [] },
      enableLinks: false,
      html2canvas: { scale: 2, backgroundColor: "#ffffff", windowWidth: REPORT_WIDTH + 40, windowHeight: 1200, scrollX: 0, scrollY: 0, logging: false },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait", compress: true },
    }).from(report);
    await worker.toContainer();
    const container = await worker.get("container");
    const overlay = await worker.get("overlay");
    // Anchor capture at the origin; centering changes when Zendesk's iframe is resized.
    Object.assign(overlay.style, { width: `${REPORT_WIDTH}px`, left: "0", right: "auto", top: "0", bottom: "auto", overflow: "visible" });
    Object.assign(container.style, { width: `${REPORT_WIDTH}px`, position: "relative", left: "0", right: "auto", top: "0", margin: "0" });
    await worker.save();
  } finally {
    // A failed canvas capture can leave html2pdf's invisible overlay behind.
    source.ownerDocument.querySelectorAll(".html2pdf__overlay").forEach(overlay => {
      if (overlay.querySelector(".pdf-report")) overlay.remove();
    });
  }
  return { fileName };
}
