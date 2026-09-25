// Shared brand furniture for the PDF exports (History/Weekly Report, System Logs).
//
// Every exported document should look like it came from the same product, so
// the gradient band, slim running header, footer and logo placement live here
// rather than being re-implemented per page. Colours come from ./tokens, which
// is the single source of truth shared with the web UI.
import { PDF_COLORS, BRAND_GRADIENT, CHART_COLORS, hexToRgb } from "./tokens";

export const BRAND_NAME = "CRAYvings";
export const BRAND_SYSTEM = `${BRAND_NAME} Monitoring System`;
export const BRAND_TAGLINE = "Smart Aquaculture \u00B7 Water Quality Monitoring";

/** The wordmark + middle-dot separator used in the slim running header. */
export function wordmark(documentLabel: string): string {
  return `${BRAND_NAME}  \u00B7  ${documentLabel}`;
}

// Palette resolved to the numeric triplets jsPDF needs.
export const PDF = {
  ink: hexToRgb(PDF_COLORS.ink),
  gray: hexToRgb(PDF_COLORS.gray),
  white: hexToRgb(PDF_COLORS.white),
  brand: hexToRgb(PDF_COLORS.brand),
  amber: hexToRgb(PDF_COLORS.amber),
  critical: hexToRgb(PDF_COLORS.critical),
  cardFill: hexToRgb(PDF_COLORS.cardFill),
  cardLine: hexToRgb(PDF_COLORS.cardLine),
  zebra: hexToRgb(PDF_COLORS.zebra),
  line: hexToRgb(PDF_COLORS.line),
  onBrand: hexToRgb(PDF_COLORS.onBrand),
  tableHead: hexToRgb(PDF_COLORS.tableHead),
  tableZebra: hexToRgb(PDF_COLORS.tableZebra),
  tableMuted: hexToRgb(PDF_COLORS.tableMuted),
  noteFill: hexToRgb(PDF_COLORS.noteFill),
  noteLine: hexToRgb(PDF_COLORS.noteLine),
  alertFill: hexToRgb(PDF_COLORS.alertFill),
  alertFillOk: hexToRgb(PDF_COLORS.alertFillOk),
  alertLine: hexToRgb(PDF_COLORS.alertLine),
  alertLineOk: hexToRgb(PDF_COLORS.alertLineOk),
  mutedText: hexToRgb(CHART_COLORS.overlay),
  gradFrom: hexToRgb(BRAND_GRADIENT.from),
  gradMid: hexToRgb(BRAND_GRADIENT.to),
  gradSolid: hexToRgb(BRAND_GRADIENT.solid),
} as const;

/** Minimal structural surface of jsPDF that these helpers rely on. */
type PdfLike = {
  setFillColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setDrawColor(r: number, g: number, b: number): void;
  setLineWidth(w: number): void;
  setFont(name: string, style?: string): void;
  setFontSize(size: number): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  text(t: string, x: number, y: number, opts?: { align?: string }): void;
  addImage(data: string, format: string, x: number, y: number, w: number, h: number): void;
};

const lerp = (a: number[], b: number[], t: number) =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);

export const fill = (doc: PdfLike, c: number[]) => doc.setFillColor(c[0], c[1], c[2]);
export const text = (doc: PdfLike, c: number[]) => doc.setTextColor(c[0], c[1], c[2]);
export const stroke = (doc: PdfLike, c: number[]) => doc.setDrawColor(c[0], c[1], c[2]);

/** Tall warm gradient that brands the top of a cover page. */
export function drawHeaderBand(doc: PdfLike, pageWidth: number, h: number): void {
  const steps = 32;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const c =
      t < 0.5
        ? lerp(PDF.gradFrom, PDF.gradMid, t * 2)
        : lerp(PDF.gradMid, PDF.amber, (t - 0.5) * 2);
    doc.setFillColor(c[0], c[1], c[2]);
    doc.rect(0, (h / steps) * i, pageWidth, h / steps + 1, "F");
  }
}

/** Slim branded strip drawn at the top of every continuation page. */
export function drawSlimHeader(
  doc: PdfLike,
  pageWidth: number,
  margin: number,
  documentLabel: string,
): void {
  fill(doc, PDF.gradSolid);
  doc.rect(0, 0, pageWidth, 11, "F");
  fill(doc, PDF.amber);
  doc.rect(0, 11, pageWidth, 1.4, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.8);
  text(doc, PDF.white);
  doc.text(wordmark(documentLabel), margin, 7.5);
}

export function drawFooter(
  doc: PdfLike,
  pageWidth: number,
  pageHeight: number,
  margin: number,
  pageNumber: number,
  exportedOn: string,
  pageTotal?: number,
): void {
  stroke(doc, PDF.line);
  doc.setLineWidth(0.5);
  doc.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  text(doc, PDF.mutedText);
  doc.text(BRAND_SYSTEM, margin, pageHeight - 7);
  // Callers that stamp footers after the document is complete can supply the
  // total; callers that draw each page as it is added cannot.
  const pageLabel = pageTotal ? `Page ${pageNumber} of ${pageTotal}` : `Page ${pageNumber}`;
  doc.text(pageLabel, pageWidth / 2, pageHeight - 7, { align: "center" });
  doc.text(`Exported: ${exportedOn}`, pageWidth - margin, pageHeight - 7, { align: "right" });
}

// ---- Logo ----
//
// jsPDF needs the image as a data URL, and the export path is otherwise
// synchronous, so the PNG is fetched and inlined once per session and cached.
// Any failure resolves to null and the document falls back to text-only
// branding rather than failing the export.

let logoPromise: Promise<string | null> | null = null;

export function loadLogoDataUrl(logoUrl: string): Promise<string | null> {
  if (!logoPromise) {
    logoPromise = (async () => {
      try {
        const res = await fetch(logoUrl);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    })();
  }
  return logoPromise;
}

/**
 * Draw the logo if it loaded. The source PNG is 500x500 with transparent
 * padding, so it is inset and drawn at a modest size to sit cleanly beside
 * the cover title.
 */
export function drawLogo(
  doc: PdfLike,
  logoDataUrl: string | null,
  x: number,
  y: number,
  size: number,
): void {
  if (!logoDataUrl) return;
  try {
    doc.addImage(logoDataUrl, "PNG", x, y, size, size);
  } catch {
    // A corrupt or unsupported image must not break the export.
  }
}
