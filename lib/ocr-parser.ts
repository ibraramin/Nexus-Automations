/**
 * Pure, dependency-free invoice text parser.
 *
 * Extracted verbatim from components/demos/InvoiceReader.tsx so the same
 * extraction logic can be exercised from node:test without a browser or OCR
 * engine. The OCR step (tesseract.js) produces text; this function turns that
 * text into the structured `Extraction` shape the demo renders.
 *
 * No network, no filesystem, no DOM. Deterministic for a given input string.
 */

export type LineItem = { description: string; qty: number; unit: string; amount: number };

export type ConfidenceKey = "vendor" | "invoiceNumber" | "date" | "totalEur" | "vatEur" | "lines";

export type Extraction = {
  source: "sample" | "ocr" | "pasted";
  vendor: string;
  invoiceNumber: string;
  date: string;
  totalEur: number;
  vatEur: number;
  vatRate: number;
  lines: LineItem[];
  confidence: Record<ConfidenceKey, number>;
  validated: boolean;
  missing: string[];
};

export function parseInvoiceText(text: string): Extraction {
  const vendor =
    (text.match(/([A-Za-zÀ-ž][A-Za-zÀ-ž .&'-]*(?:GmbH|Ltd|B\.V\.|S\.A\.|UG|AG|PLC|Corp|Co\.))/i)?.[1] ??
      (text.split("\n").find((l) => /[A-Za-z]{3}/.test(l) && l.trim().length < 60)?.trim() ?? "")) ||
    "Unknown vendor";

  const invoiceNumber =
    (text.match(/(?:invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*)([A-Z0-9][A-Z0-9\-/]{3,})/i)?.[1] ??
      text.match(/\b(?:INV|2026)-?\d{3,}/i)?.[0] ??
      "") ||
    "Unknown";

  const date =
    (text.match(/\b(\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4})\b/)?.[1] ??
      text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ??
      "") ||
    "Unknown";

  const parseMoney = (s?: string) => {
    if (!s) return null;
    const cleaned = s.replace(/[^\d.,]/g, "").trim();
    if (!cleaned) return null;
    if (cleaned.includes(",") && cleaned.includes(".")) {
      const last = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
      return parseFloat(cleaned.split(last).join("").replace(/[.,]/g, "") + "." + cleaned.split(last)[1]);
    }
    return parseFloat(cleaned.replace(",", "."));
  };

  const totalEur =
    parseMoney(text.match(/(?:total|amount\s*due|grand\s*total|summe|gesamt)\s*[:€]?\s*[€]?\s*([\d.,]+)/i)?.[1]) ?? null;

  const vatEur =
    parseMoney(text.match(/(?:vat|mws(t)?|tax|ust)\s*[:€]?\s*[€]?\s*([\d.,]+)/i)?.[2]) ?? null;

  const rateMatch = text.match(/(?:vat|mws|tax)\s*(?:rate)?\s*[:]?\s*(\d{1,2})\s*%/i);
  const vatRate = rateMatch ? parseInt(rateMatch[1], 10) : vatEur && totalEur ? Math.round((vatEur / (totalEur - vatEur)) * 100) : 0;

  const lines: LineItem[] = text
    .split("\n")
    .map((line) => line.trim())
    .filter((l) => /^\d/.test(l) && /€|[\d.,]+$/.test(l))
    .slice(0, 8)
    .map((l) => {
      const desc = l.replace(/€[\s\d.,]+$/g, "").replace(/\s{2,}/g, " ").slice(0, 60);
      const amount = parseMoney(l.match(/([\d.,]+)\s*€?$/)?.[1]) ?? 0;
      const qty = parseInt(l.match(/^(\d+)/)?.[1] ?? "1", 10);
      return { description: desc || "Line item", qty, unit: "pcs", amount };
    })
    .filter((l) => l.amount > 0);

  const missing: string[] = [];
  if (!vendor || vendor === "Unknown vendor") missing.push("vendor");
  if (!invoiceNumber || invoiceNumber === "Unknown") missing.push("invoiceNumber");
  if (!date || date === "Unknown") missing.push("date");
  if (totalEur === null) missing.push("totalEur");

  return {
    source: "ocr",
    vendor: vendor || "Unknown vendor",
    invoiceNumber: invoiceNumber || "Unknown",
    date: date || "Unknown",
    totalEur: totalEur ?? 0,
    vatEur: vatEur ?? 0,
    vatRate,
    lines,
    confidence: {
      vendor: 92,
      invoiceNumber: 88,
      date: 90,
      totalEur: 85,
      vatEur: 82,
      lines: lines.length ? 80 : 0,
    },
    validated: missing.length === 0,
    missing,
  };
}
