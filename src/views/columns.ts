// Table columns for a set of values of possibly many shapes.  Records
// contribute a column per leaf field (nested records are flattened into
// dotted paths); the columns of all shapes are merged by path, in the order
// they first appear.  Any other value is shown in a column named "this".

import { leafColumnsOf, recordOf, type Type, type Value } from "@superdb/super-ts"

export interface TableColumn {
  /** A unique key for the column's path. */
  id: string
  path: string[]
  label: string
}

const THIS = "\u0000this"

export function buildColumns(shapes: readonly Type[]): TableColumn[] {
  const cols: TableColumn[] = []
  const seen = new Set<string>()
  const add = (id: string, path: string[], label: string) => {
    if (seen.has(id)) return
    seen.add(id)
    cols.push({ id, path, label })
  }
  for (const shape of shapes) {
    if (!recordOf(shape)) {
      add(THIS, [], "this")
      continue
    }
    for (const c of leafColumnsOf(shape)) add(c.path.join("\u0000"), c.path, c.path.join("."))
  }
  return cols
}

/** Finds the value of each column in a row, caching the lookup per shape. */
export class CellLookup {
  private columns: readonly TableColumn[]
  private byShape = new Map<Type, (readonly number[] | null)[]>()

  constructor(columns: readonly TableColumn[]) {
    this.columns = columns
  }

  private indexPaths(shape: Type): (readonly number[] | null)[] {
    let paths = this.byShape.get(shape)
    if (paths) return paths
    const rec = recordOf(shape)
    const ids = new Map<string, readonly number[]>()
    if (rec) {
      for (const c of leafColumnsOf(shape)) ids.set(c.path.join("\u0000"), c.indexPath)
    } else {
      ids.set(THIS, [])
    }
    paths = this.columns.map((c) => ids.get(c.id) ?? null)
    this.byShape.set(shape, paths)
    return paths
  }

  /** The value of column k in row v, or undefined if v's shape lacks the column. */
  cell(v: Value, k: number): Value | undefined {
    const path = this.indexPaths(v.type)[k]
    if (!path) return undefined
    if (path.length === 0) return v
    const rec = v.unwrap()
    return rec.kind === "record" ? rec.fieldAt(path) : undefined
  }
}

/** The distinct shapes of values with how many values have each, in order of appearance. */
export function shapeCounts(values: readonly Value[]): Map<Type, number> {
  const counts = new Map<Type, number>()
  for (const v of values) counts.set(v.type, (counts.get(v.type) ?? 0) + 1)
  return counts
}
