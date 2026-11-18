// The model behind the inspector: an expandable tree of values flattened
// into rows for a virtual list.  Type values expand too, into the fields and
// members of the type they hold.  It has no DOM code so it can be tested in
// Node.

import { formatType, quotedName, type Type, type TypeRecord, type TypeUnion, type Value } from "@superdb/super-ts"
import { sup, truncate } from "./cells.ts"

/** Children shown per container before a "show more" row. */
export const PAGE = 200

export type Row =
  | {
      kind: "value"
      depth: number
      path: string
      key: string | undefined
      value: Value
      expandable: boolean
      expanded: boolean
    }
  | {
      // A type inside a type value.
      kind: "type"
      depth: number
      path: string
      key: string | undefined
      type: Type
      // Text before the type: "|" for a union member after the first.
      lead: string
      expandable: boolean
      expanded: boolean
    }
  | { kind: "close"; depth: number; path: string; text: string; ofType: boolean }
  | { kind: "more"; depth: number; path: string; parent: string; shown: number; total: number }

export type ValueRow = Extract<Row, { kind: "value" }>
export type TypeRow = Extract<Row, { kind: "type" }>

/** Something the tree shows: a value, or a type inside a type value. */
type Node = { kind: "value"; value: Value } | { kind: "type"; type: Type; lead: string }

interface Child {
  key: string | undefined
  node: Node
}

/** The structure of v for the tree: looks through options, unions, and fusions. */
function structural(v: Value): Value {
  let u = v.unwrap()
  if (u.kind === "error") {
    const inner = u.value.unwrap()
    switch (inner.kind) {
      case "record":
      case "array":
      case "set":
      case "map":
      case "type":
        u = inner
    }
  }
  return u
}

/** True if v is a type value (or an error wrapping one), whose rows are types. */
export function holdsType(v: Value): boolean {
  return structural(v).kind === "type"
}

// Types in the tree.  A type expands if it has a record somewhere inside it
// that a click can open.  The wrappers around that record, such as
// fusion(missing|{...}) or [{...}], are shown as written on the rows that open
// and close it, so a field's type opens straight onto the record's fields and
// the rows read as the type's SUP text.  A union with more than one member
// that expands is the exception: its members are the children.  SUP writes a
// named type by name inside a type value, so a named type opens to its
// definition, as in "type port={...}": port={ ... }.

interface Opening {
  /** The text on the row that opens the type, e.g., `fusion(missing|{`. */
  open: string
  /** The text on the row that closes it, e.g., `})`. */
  close: string
  /** The record whose fields, or union whose members, are the children. */
  inner: TypeRecord | TypeUnion
}

const openings = new WeakMap<Type, Opening | null>()

/** How t opens in the tree, or null if it doesn't expand. */
function opening(t: Type): Opening | null {
  let o = openings.get(t)
  if (o === undefined) {
    // A named type can refer to itself, e.g., through a union.
    openings.set(t, null)
    o = findOpening(t)
    openings.set(t, o)
  }
  return o
}

function wrap(o: Opening | null, open: string, close: string): Opening | null {
  return o && { open: open + o.open, close: o.close + close, inner: o.inner }
}

function findOpening(t: Type): Opening | null {
  switch (t.kind) {
    case "record":
      return t.fields.length > 0 ? { open: "{", close: "}", inner: t } : null
    case "array":
      return wrap(opening(t.type), "[", "]")
    case "set":
      return wrap(opening(t.type), "set[", "]")
    case "map":
      return wrap(opening(t.valType), `map{${typeString(t.keyType)}:`, "}")
    case "error":
      return wrap(opening(t.type), "error(", ")")
    case "fusion":
      return wrap(opening(t.type), "fusion(", ")")
    case "option":
      return wrap(opening(t.type), "option(", ")")
    case "union": {
      const k = t.types.findIndex((m) => opening(m) !== null)
      if (k < 0) return null
      if (t.types.some((m, j) => j > k && opening(m) !== null)) return { open: "", close: "", inner: t }
      const before = t.types.slice(0, k).map((m) => typeString(m) + "|")
      const after = t.types.slice(k + 1).map((m) => "|" + typeString(m))
      return wrap(opening(t.types[k]), before.join(""), after.join(""))
    }
    case "named": {
      const o = opening(t.type)
      if (!o) return null
      // A union of records needs parentheses after the "=".
      const bare = o.open === ""
      return wrap(o, quotedName(t.name) + (bare ? "=(" : "="), bare ? ")" : "")
    }
    default:
      // Primitives, enums, and decimals.
      return null
  }
}

function typeChildCount(t: Type): number {
  const o = opening(t)
  if (!o) return 0
  return o.inner.kind === "record" ? o.inner.fields.length : o.inner.types.length
}

function typeChildren(t: Type, from: number, to: number): Child[] {
  const o = opening(t)
  const out: Child[] = []
  if (!o) return out
  if (o.inner.kind === "record") {
    const fields = o.inner.fields
    for (let k = from; k < Math.min(to, fields.length); k++) {
      const name = quotedName(fields[k].name)
      const ft = fields[k].type
      // An optional field is written name?:type.
      if (ft.kind === "option") out.push({ key: name + "?", node: { kind: "type", type: ft.type, lead: "" } })
      else out.push({ key: name, node: { kind: "type", type: ft, lead: "" } })
    }
  } else {
    const types = o.inner.types
    for (let k = from; k < Math.min(to, types.length); k++) {
      out.push({ key: undefined, node: { kind: "type", type: types[k], lead: k > 0 ? "|" : "" } })
    }
  }
  return out
}

/** A bare union opens with a parenthesis, since its own text would be empty. */
function typeOpen(t: Type): string {
  const o = opening(t)
  if (!o) return ""
  return o.open === "" ? "(" : o.open
}

function typeClose(t: Type): string {
  const o = opening(t)
  if (!o) return ""
  return o.close === "" ? ")" : o.close
}

const typeTexts = new WeakMap<Type, string>()

/** The SUP text of t (cached; types are immutable). */
function typeString(t: Type): string {
  let s = typeTexts.get(t)
  if (s === undefined) {
    s = formatType(t)
    typeTexts.set(t, s)
  }
  return s
}

/** The text of a type row when it's collapsed. */
export function typeText(row: TypeRow): string {
  return row.lead + typeString(row.type)
}

/** The hover text of a type: a named type's definition, or the whole type. */
function title(t: Type): string {
  if (t.kind === "named") return `type ${quotedName(t.name)}=${typeString(t.type)}`
  return typeString(t)
}

/** The hover text of a type row that doesn't expand. */
export function typeTitle(row: TypeRow): string {
  return title(row.type)
}

/** The hover text of a value row that doesn't expand. */
export function valueTitle(v: Value): string {
  const u = structural(v)
  if (u.kind === "type" && u.value.kind === "named") return title(u.value)
  return sup(v)
}

function childCount(n: Node): number {
  if (n.kind === "type") return typeChildCount(n.type)
  const u = structural(n.value)
  switch (u.kind) {
    case "record":
      return u.values.length
    case "array":
    case "set":
      return u.items.length
    case "map":
      return u.entries.length
    case "type":
      return typeChildCount(u.value)
    default:
      return 0
  }
}

function children(n: Node, from: number, to: number): Child[] {
  if (n.kind === "type") return typeChildren(n.type, from, to)
  const u = structural(n.value)
  const out: Child[] = []
  switch (u.kind) {
    case "record": {
      const fields = u.recordType.fields
      for (let k = from; k < Math.min(to, u.values.length); k++) {
        out.push({ key: fields[k].name, node: { kind: "value", value: u.values[k] } })
      }
      break
    }
    case "array":
    case "set":
      for (let k = from; k < Math.min(to, u.items.length); k++) {
        out.push({ key: String(k), node: { kind: "value", value: u.items[k] } })
      }
      break
    case "map":
      for (let k = from; k < Math.min(to, u.entries.length); k++) {
        const [key, value] = u.entries[k]
        out.push({ key: truncate(sup(key), 80), node: { kind: "value", value } })
      }
      break
    case "type":
      return typeChildren(u.value, from, to)
  }
  return out
}

/** The opening text of an expanded row. */
export function openText(row: ValueRow | TypeRow): string {
  if (row.kind === "type") return row.lead + typeOpen(row.type)
  const v = row.value
  const u = structural(v)
  const prefix = v.unwrap().kind === "error" ? "error(" : ""
  switch (u.kind) {
    case "record":
      return prefix + "{"
    case "array":
      return prefix + "["
    case "set":
      return prefix + "set["
    case "map":
      return prefix + "map{"
    case "type":
      // The angle brackets already enclose a bare union.
      return prefix + "<" + (opening(u.value)?.open ?? "")
    default:
      return ""
  }
}

function closeText(n: Node): string {
  if (n.kind === "type") return typeClose(n.type)
  const v = n.value
  const u = structural(v)
  let s: string
  switch (u.kind) {
    case "record":
    case "map":
      s = "}"
      break
    case "type":
      s = (opening(u.value)?.close ?? "") + ">"
      break
    default:
      s = "]"
  }
  if (v.unwrap().kind === "error") s += ")"
  if (v.type.kind === "named") s += `::${v.type.name}`
  return s
}

/** Values for a view, which may decode them only when they're asked for. */
export interface ValueSource {
  readonly length: number
  get(i: number): Value
}

/** A source for values in memory. */
export function arraySource(values: readonly Value[]): ValueSource {
  return { length: values.length, get: (i) => values[i] }
}

// How many subtrees of top-level values to keep built.  Others are rebuilt
// (from the source) when they're needed again, so the rows of values that
// have scrolled out of view can be garbage collected.
const SUBTREE_CACHE = 500

/**
 * The tree's rows.  A value at the top of the tree takes one row when it's
 * collapsed and the rows of its subtree when it's expanded.  Only the
 * subtrees of expanded values are built, and only when they're needed, so
 * the tree can hold any number of values without decoding them all.
 */
export class TreeModel {
  readonly source: ValueSource
  private expanded = new Set<string>()
  private shown = new Map<string, number>()
  // The number of rows of each expanded top-level value.
  private sizes = new Map<number, number>()
  // The keys of sizes in order, with the extra rows before each.
  private order: number[] | undefined
  private extra: number[] = []
  private total = 0
  private subtrees = new Map<number, Row[]>()

  constructor(source: ValueSource | readonly Value[]) {
    this.source = "get" in source ? source : arraySource(source)
    this.total = this.source.length
  }

  /** The number of rows. */
  get rowCount(): number {
    return this.total
  }

  /** All of the rows (which builds the subtree of every expanded value). */
  rows(): Row[] {
    const out: Row[] = []
    for (let i = 0; i < this.source.length; i++) out.push(...this.subtree(i))
    return out
  }

  /** Row r. */
  row(r: number): Row {
    const { item, offset } = this.locate(r)
    return this.subtree(item)[offset]
  }

  private index() {
    if (this.order) return
    this.order = [...this.sizes.keys()].sort((a, b) => a - b)
    this.extra = []
    let extra = 0
    for (const i of this.order) {
      this.extra.push(extra)
      extra += this.sizes.get(i)! - 1
    }
  }

  /** The top-level value at row r and the row's position in its subtree. */
  locate(r: number): { item: number; offset: number } {
    this.index()
    const order = this.order!
    // Find the last expanded value starting at or before row r.
    let lo = 0
    let hi = order.length - 1
    let k = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (order[mid] + this.extra[mid] <= r) {
        k = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (k < 0) return { item: r, offset: 0 }
    const start = order[k] + this.extra[k]
    const size = this.sizes.get(order[k])!
    if (r < start + size) return { item: order[k], offset: r - start }
    return { item: order[k] + 1 + (r - start - size), offset: 0 }
  }

  /** The row of top-level value i. */
  rowOf(i: number): number {
    this.index()
    const order = this.order!
    let lo = 0
    let hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (order[mid] < i) lo = mid + 1
      else hi = mid
    }
    if (lo === 0) return i
    return i + this.extra[lo - 1] + this.sizes.get(order[lo - 1])! - 1
  }

  // subtree returns the rows of top-level value i, building them if needed.
  private subtree(i: number): Row[] {
    let rows = this.subtrees.get(i)
    if (rows) {
      this.subtrees.delete(i)
      this.subtrees.set(i, rows)
      return rows
    }
    rows = []
    this.walk(rows, { kind: "value", value: this.source.get(i) }, String(i), undefined, 0)
    this.subtrees.set(i, rows)
    if (this.subtrees.size > SUBTREE_CACHE) this.subtrees.delete(this.subtrees.keys().next().value!)
    this.setSize(i, rows.length)
    return rows
  }

  private setSize(i: number, size: number) {
    const old = this.sizes.get(i) ?? 1
    if (old === size) return
    if (size > 1) this.sizes.set(i, size)
    else this.sizes.delete(i)
    this.total += size - old
    this.order = undefined
  }

  // rebuild rebuilds the subtree of top-level value i after its expansion
  // changed.
  private rebuild(i: number) {
    this.subtrees.delete(i)
    this.subtree(i)
  }

  private walk(out: Row[], node: Node, path: string, key: string | undefined, depth: number) {
    const total = childCount(node)
    const expandable = total > 0
    const expanded = expandable && this.expanded.has(path)
    out.push({ ...node, depth, path, key, expandable, expanded })
    if (!expanded) return
    const shown = Math.min(total, this.shown.get(path) ?? PAGE)
    children(node, 0, shown).forEach((c, k) => this.walk(out, c.node, `${path}/${k}`, c.key, depth + 1))
    if (shown < total) out.push({ kind: "more", depth: depth + 1, path: `${path}/more`, parent: path, shown, total })
    const ofType = node.kind === "type" || holdsType(node.value)
    out.push({ kind: "close", depth, path: `${path}/close`, text: closeText(node), ofType })
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path)
  }

  /** Whether top-level value i has been expanded (by any of the methods). */
  isOpened(i: number): boolean {
    return this.expanded.has(String(i))
  }

  toggle(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else this.expanded.add(path)
    this.rebuild(parseInt(path, 10))
  }

  showMore(parent: string) {
    this.shown.set(parent, (this.shown.get(parent) ?? PAGE) + PAGE)
    this.rebuild(parseInt(parent, 10))
  }

  collapseAll() {
    this.expanded.clear()
    this.shown.clear()
    this.sizes.clear()
    this.subtrees.clear()
    this.order = undefined
    this.total = this.source.length
  }

  /**
   * Expands the tree breadth first while the number of rows stays within
   * budget, so small results are shown in full and big ones stay compact.
   * Only the first budget values can be looked at, so a result with more
   * values than budget stays collapsed.
   */
  expandWithin(budget: number, maxDepth = 12) {
    this.collapseAll()
    const n = Math.min(this.source.length, budget)
    this.expandBreadthFirst(
      Array.from({ length: n }, (_, i) => i),
      this.source.length,
      budget,
      maxDepth,
    )
  }

  /**
   * Expands top-level value i breadth first while its subtree stays within
   * budget rows (e.g., to show it fully expanded when it scrolls into view).
   */
  expandItem(i: number, budget: number, maxDepth = 64) {
    this.expandBreadthFirst([i], 1, budget, maxDepth)
  }

  private expandBreadthFirst(items: number[], total: number, budget: number, maxDepth: number) {
    let level: { node: Node; path: string }[] = items.map((i) => ({
      node: { kind: "value", value: this.source.get(i) },
      path: String(i),
    }))
    const touched = new Set<number>()
    for (let depth = 0; depth < maxDepth && level.length > 0 && total < budget; depth++) {
      const next: { node: Node; path: string }[] = []
      for (const { node, path } of level) {
        const n = childCount(node)
        if (n === 0) continue
        const shown = Math.min(n, PAGE)
        const added = shown + 1 + (shown < n ? 1 : 0)
        if (total + added > budget) continue
        total += added
        this.expanded.add(path)
        touched.add(parseInt(path, 10))
        children(node, 0, shown).forEach((c, k) => next.push({ node: c.node, path: `${path}/${k}` }))
      }
      level = next
    }
    for (const i of touched) this.rebuild(i)
  }
}
