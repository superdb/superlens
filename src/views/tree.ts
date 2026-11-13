// The model behind the inspector: an expandable tree of values flattened
// into rows for a virtual list.  It has no DOM code so it can be tested in
// Node.

import type { Value } from "@superdb/super-ts"
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
  | { kind: "close"; depth: number; path: string; text: string }
  | { kind: "more"; depth: number; path: string; parent: string; shown: number; total: number }

interface Child {
  key: string
  value: Value
}

/** The structure of v for the tree: looks through options, unions, and fusions. */
function structural(v: Value): Value {
  let u = v.unwrap()
  if (u.kind === "error") {
    const inner = u.value.unwrap()
    if (inner.kind === "record" || inner.kind === "array" || inner.kind === "set" || inner.kind === "map") u = inner
  }
  return u
}

export function childCount(v: Value): number {
  const u = structural(v)
  switch (u.kind) {
    case "record":
      return u.values.length
    case "array":
    case "set":
      return u.items.length
    case "map":
      return u.entries.length
    default:
      return 0
  }
}

export function isExpandable(v: Value): boolean {
  return childCount(v) > 0
}

function children(v: Value, from: number, to: number): Child[] {
  const u = structural(v)
  const out: Child[] = []
  switch (u.kind) {
    case "record": {
      const fields = u.recordType.fields
      for (let k = from; k < Math.min(to, u.values.length); k++) out.push({ key: fields[k].name, value: u.values[k] })
      break
    }
    case "array":
    case "set":
      for (let k = from; k < Math.min(to, u.items.length); k++) out.push({ key: String(k), value: u.items[k] })
      break
    case "map":
      for (let k = from; k < Math.min(to, u.entries.length); k++) {
        const [key, value] = u.entries[k]
        out.push({ key: truncate(sup(key), 80), value })
      }
      break
  }
  return out
}

/** The opening bracket of an expanded container. */
export function openText(v: Value): string {
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
    default:
      return ""
  }
}

function closeText(v: Value): string {
  const u = structural(v)
  let s = u.kind === "record" || u.kind === "map" ? "}" : "]"
  if (v.unwrap().kind === "error") s += ")"
  if (v.type.kind === "named") s += `::${v.type.name}`
  return s
}

export class TreeModel {
  readonly values: readonly Value[]
  private expanded = new Set<string>()
  private shown = new Map<string, number>()
  private cache: Row[] | undefined

  constructor(values: readonly Value[]) {
    this.values = values
  }

  /** The visible rows. */
  rows(): Row[] {
    if (!this.cache) {
      const out: Row[] = []
      this.values.forEach((v, i) => this.walk(out, v, String(i), undefined, 0))
      this.cache = out
    }
    return this.cache
  }

  private walk(out: Row[], value: Value, path: string, key: string | undefined, depth: number) {
    const expandable = isExpandable(value)
    const expanded = expandable && this.expanded.has(path)
    out.push({ kind: "value", depth, path, key, value, expandable, expanded })
    if (!expanded) return
    const total = childCount(value)
    const shown = Math.min(total, this.shown.get(path) ?? PAGE)
    children(value, 0, shown).forEach((c, k) => this.walk(out, c.value, `${path}/${k}`, c.key, depth + 1))
    if (shown < total) out.push({ kind: "more", depth: depth + 1, path: `${path}/more`, parent: path, shown, total })
    out.push({ kind: "close", depth, path: `${path}/close`, text: closeText(value) })
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path)
  }

  toggle(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else this.expanded.add(path)
    this.cache = undefined
  }

  showMore(parent: string) {
    this.shown.set(parent, (this.shown.get(parent) ?? PAGE) + PAGE)
    this.cache = undefined
  }

  collapseAll() {
    this.expanded.clear()
    this.shown.clear()
    this.cache = undefined
  }

  /**
   * Expands the tree breadth first while the number of rows stays within
   * budget, so small results are shown in full and big ones stay compact.
   */
  expandWithin(budget: number, maxDepth = 12) {
    this.expanded.clear()
    this.shown.clear()
    let total = this.values.length
    let level: { value: Value; path: string }[] = this.values.map((value, i) => ({ value, path: String(i) }))
    for (let depth = 0; depth < maxDepth && level.length > 0 && total < budget; depth++) {
      const next: { value: Value; path: string }[] = []
      for (const { value, path } of level) {
        const n = childCount(value)
        if (n === 0) continue
        const shown = Math.min(n, PAGE)
        const added = shown + 1 + (shown < n ? 1 : 0)
        if (total + added > budget) continue
        total += added
        this.expanded.add(path)
        children(value, 0, shown).forEach((c, k) => next.push({ value: c.value, path: `${path}/${k}` }))
      }
      level = next
    }
    this.cache = undefined
  }
}
