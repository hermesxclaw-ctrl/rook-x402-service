import { JSDOM } from "jsdom";
import { marked } from "marked";
import TurndownService from "turndown";

export type Format = "markdown" | "html" | "text" | "json" | "csv";

const MAX_INPUT_CHARS = 1_000_000;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function htmlToText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  return (doc.body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textToHtml(text: string): string {
  const paras = text.split(/\n{2,}|\r\n{2,}/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`);
  return paras.join("\n");
}

function csvEscape(cell: unknown): string {
  const s = cell === null || cell === undefined ? "" : String(cell);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function jsonToCsv(input: string): string {
  const data: unknown = JSON.parse(input);
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return "";
  if (!rows.every((r) => typeof r === "object" && r !== null && !Array.isArray(r))) {
    throw new Error("json->csv needs an array of objects (or a single object)");
  }
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r as Record<string, unknown>)))];
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) {
    const rec = r as Record<string, unknown>;
    lines.push(
      headers
        .map((h) => {
          const v = rec[h];
          return csvEscape(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  row.push(cell);
  rows.push(row);
  // drop trailing empty row from final newline
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return rows;
}

function csvToJson(input: string): string {
  const rows = parseCsv(input).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) return "[]";
  const [header, ...data] = rows;
  const objs = data.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h.trim() || `col${i + 1}`] = (r[i] ?? "").trim();
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

export function convert(from: Format, to: Format, input: string): string {
  if (input.length > MAX_INPUT_CHARS) throw new Error("input too large (>1MB)");
  if (from === to) return input;

  // normalize everything through an intermediate where convenient
  const toHtml = (f: Format, s: string): string => {
    switch (f) {
      case "html":
        return s;
      case "markdown":
        return marked.parse(s, { async: false }) as string;
      case "text":
        return textToHtml(s);
      default:
        throw new Error(`cannot convert ${f} to html`);
    }
  };

  if (to === "html") return toHtml(from, input);
  if (to === "text") return htmlToText(toHtml(from, input));
  if (to === "markdown") {
    if (from === "html") return turndown.turndown(input);
    if (from === "text") return input; // plain text is valid markdown
    throw new Error(`cannot convert ${from} to markdown`);
  }
  if (to === "csv") {
    if (from === "json") return jsonToCsv(input);
    throw new Error(`cannot convert ${from} to csv`);
  }
  if (to === "json") {
    if (from === "csv") return csvToJson(input);
    throw new Error(`cannot convert ${from} to json`);
  }
  throw new Error(`unsupported conversion: ${from} -> ${to}`);
}

export const FORMATS: Format[] = ["markdown", "html", "text", "json", "csv"];
