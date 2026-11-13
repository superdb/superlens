// Text and styling of values in the views.

import { formatPrimitive, type Value } from "@superdb/super-ts"

const supCache = new WeakMap<Value, string>()

/** The SUP text of v (cached; values are immutable). */
export function sup(v: Value): string {
  let s = supCache.get(v)
  if (s === undefined) {
    s = v.toString()
    supCache.set(v, s)
  }
  return s
}

/** s cut to at most max characters, with an ellipsis if cut. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

/** The CSS class for a value's syntax color. */
export function kindClass(v: Value): string {
  const u = v.unwrap()
  switch (u.kind) {
    case "string":
      return "k-string"
    case "int":
    case "uint":
    case "float":
      return "k-number"
    case "bool":
      return "k-bool"
    case "null":
    case "missing":
    case "none":
      return "k-null"
    case "timestamp":
    case "duration":
      return "k-time"
    case "ip":
    case "net":
    case "uuid":
      return "k-net"
    case "type":
      return "k-type"
    case "error":
      return "k-error"
    case "bytes":
    case "unimplemented":
      return "k-bytes"
    case "enum":
      return "k-enum"
    case "option":
      return "k-null"
    default:
      return "k-container"
  }
}

const MAX_CELL = 300

/**
 * The text of a value in a table cell: strings without quotes, other
 * primitives without type decorators, and containers as truncated SUP.
 */
export function cellText(v: Value): string {
  const u = v.unwrap()
  switch (u.kind) {
    case "string":
      return truncate(u.value, MAX_CELL)
    case "null":
      return "null"
    case "missing":
    case "none":
      return ""
    case "option":
      return u.value === null ? "" : cellText(u.value)
    case "enum":
      return u.symbol
    case "error":
      return truncate(`error(${sup(u.value)})`, MAX_CELL)
    case "record":
    case "array":
    case "set":
    case "map":
      return truncate(sup(u), MAX_CELL)
    default:
      return truncate(formatPrimitive(u), MAX_CELL)
  }
}

/** True if a table cell for v should be right-aligned. */
export function isNumeric(v: Value): boolean {
  const k = v.unwrap().kind
  return k === "int" || k === "uint" || k === "float" || k === "duration"
}

/** An element showing value text with its syntax color. */
export function valueSpan(v: Value, text: string): HTMLElement {
  const span = document.createElement("span")
  span.className = kindClass(v)
  span.textContent = text
  return span
}

/** A plain JSON rendering of a value (for copying). */
export function toJSON(v: Value): string {
  return JSON.stringify(
    v.toJS(),
    (_, x) => {
      if (typeof x === "bigint") return x.toString()
      if (x instanceof Map) return Object.fromEntries([...x].map(([k, y]) => [String(k), y]))
      if (x instanceof Uint8Array) return "0x" + Array.from(x, (b) => b.toString(16).padStart(2, "0")).join("")
      return x
    },
    2,
  )
}
