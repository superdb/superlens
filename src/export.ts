// Copy and Download: the formats results can be saved in, and the query
// that makes them.  It has no DOM code so it can be tested in Node.

import { addOperator } from "./query.ts"

export interface ExportFormat {
  /** SuperDB's name for the format, e.g., "csv". */
  name: string
  /** The name shown in the menu. */
  label: string
  /** The extension of the downloaded file. */
  ext: string
  /** Binary formats can be downloaded but not copied. */
  binary: boolean
  /** Formats that need one set of columns for all values get "| fuse". */
  tabular: boolean
  /**
   * Keeps fusion values instead of defusing them, which super does only
   * for BSUP (super -f bsup).  Whatever reads the file defuses them when
   * it shows the values.
   */
  fusion: boolean
}

// The same formats as the input Format menu, in alphabetical order by
// label, as there.  SuperDB writes JSON as one value per line, so it's
// called NDJSON here, as in zui.
export const EXPORT_FORMATS: readonly ExportFormat[] = [
  { name: "arrows", label: "Arrow IPC stream", ext: "arrows", binary: true, tabular: true, fusion: false },
  { name: "bsup", label: "BSUP", ext: "bsup", binary: true, tabular: false, fusion: true },
  { name: "csv", label: "CSV", ext: "csv", binary: false, tabular: true, fusion: false },
  { name: "line", label: "lines of text", ext: "txt", binary: false, tabular: false, fusion: false },
  { name: "json", label: "NDJSON", ext: "ndjson", binary: false, tabular: false, fusion: false },
  { name: "parquet", label: "Parquet", ext: "parquet", binary: true, tabular: true, fusion: false },
  { name: "sup", label: "SUP", ext: "sup", binary: false, tabular: false, fusion: false },
  { name: "tsv", label: "TSV", ext: "tsv", binary: false, tabular: true, fusion: false },
  { name: "zeek", label: "Zeek", ext: "log", binary: false, tabular: false, fusion: false },
]

export const DEFAULT_EXPORT_FORMAT = "sup"

/** The format named name, or the default format if there isn't one. */
export function exportFormat(name: string | null): ExportFormat {
  const f = EXPORT_FORMATS.find((f) => f.name === name) ?? EXPORT_FORMATS.find((f) => f.name === DEFAULT_EXPORT_FORMAT)
  return f!
}

/**
 * The query that makes a download in format from the query that made the
 * results.  A tabular format needs one set of columns for all values, so
 * the query gets "| fuse" (unless it already ends with fuse), as in zui.
 * fused says whether it was added.
 */
export function exportQuery(query: string, format: ExportFormat): { query: string; fused: boolean } {
  if (!format.tabular) return { query, fused: false }
  const q = addOperator(query, "fuse", /(^|\|>?)\s*fuse$/)
  return { query: q, fused: q !== query.replace(/[\s;]+$/, "").trim() }
}
