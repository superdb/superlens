// Table columns for values of possibly many shapes.  Records contribute a
// column per leaf field (nested records are flattened into dotted paths),
// and the columns of all shapes are merged by path, in the order they first
// appear.  Any other value is shown in a column named "this".
//
// The columns come from types, not values, so a big result's columns come
// from the fused types of its frames, without decoding its values: a fused
// type has every field of every value, with fusion, option, and union types
// where values differ, and these are looked through to find the records.

import { under, type Type, type Value } from "@superdb/super-ts"

export interface TableColumn {
  /** A unique key for the column's path. */
  id: string
  path: string[]
  label: string
}

const THIS = "\u0000this"

// Types nested more deeply than this (e.g., a recursive named type) don't
// get columns of their own.
const MAX_DEPTH = 32

/** The columns for values of the given types. */
export function buildColumns(types: readonly Type[]): TableColumn[] {
  const cols: TableColumn[] = []
  const seen = new Set<string>()
  const add = (path: string[]) => {
    const id = path.length === 0 ? THIS : path.join("\u0000")
    if (seen.has(id)) return
    seen.add(id)
    cols.push({ id, path, label: path.length === 0 ? "this" : path.join(".") })
  }
  const walk = (t: Type, path: string[], depth: number) => {
    let u = under(t)
    while ((u.kind === "fusion" || u.kind === "option") && depth < MAX_DEPTH) {
      u = under(u.type)
      depth++
    }
    if (u.kind === "union" && depth < MAX_DEPTH) {
      for (const m of u.types) walk(m, path, depth + 1)
      return
    }
    // A missing or none member of a union isn't a value to show.
    if (u.kind === "primitive" && (u.name === "missing" || u.name === "none") && path.length > 0) return
    if (u.kind === "record" && u.fields.length > 0 && depth < MAX_DEPTH) {
      for (const f of u.fields) walk(f.type, [...path, f.name], depth + 1)
      return
    }
    add(path)
  }
  for (const t of types) walk(t, [], 0)
  return cols
}

/** Finds the value of each column in a row by following the column's path. */
export class CellLookup {
  private columns: readonly TableColumn[]

  constructor(columns: readonly TableColumn[]) {
    this.columns = columns
  }

  /** The value of column k in row v, or undefined if v doesn't have the column. */
  cell(v: Value, k: number): Value | undefined {
    const path = this.columns[k].path
    if (path.length === 0) return v.unwrap().kind === "record" ? undefined : v
    let cur: Value | undefined = v
    for (const name of path) {
      const rec: Value = cur.unwrap()
      if (rec.kind !== "record") return undefined
      cur = rec.get(name)
      if (cur === undefined) return undefined
    }
    return cur
  }
}

/** The distinct shapes of values with how many values have each, in order of appearance. */
export function shapeCounts(values: readonly Value[]): Map<Type, number> {
  const counts = new Map<Type, number>()
  for (const v of values) counts.set(v.type, (counts.get(v.type) ?? 0) + 1)
  return counts
}
