// Query results for the views.  The engine leaves fused values fused, and
// the results keep its BSUP: values are decoded and defused only when a
// view asks for them, and the most recently used ones are cached.  Values
// that drop out of the cache can be garbage collected, so scrolling through
// a big result doesn't keep it all in memory.

import { BSUPResults, Defuser, hasFusion, type Type, type TypeContext, type Value } from "@superdb/super-ts"
import type { ValueSource } from "./views/tree.ts"

/** Decoded values to keep, which is more than any view shows at once. */
export const VALUE_CACHE = 2000

export class ResultSet implements ValueSource {
  readonly length: number
  /** The fused types of the BSUP's frames, which the table's columns come from. */
  readonly fusedTypes: readonly Type[]
  readonly warnings: readonly string[]
  /** The size of the BSUP. */
  readonly bytes: number
  private bsup: BSUPResults
  private defuser: Defuser
  private cache = new Map<number, Value>()
  private cacheSize: number

  constructor(bsup: Uint8Array, context: TypeContext, cacheSize = VALUE_CACHE) {
    this.bsup = new BSUPResults(bsup, { context })
    if (this.bsup.errors.length > 0) throw new Error(this.bsup.errors[0])
    this.defuser = new Defuser(context)
    this.length = this.bsup.length
    this.fusedTypes = this.bsup.fusedTypes
    this.warnings = this.bsup.warnings
    this.bytes = bsup.length
    this.cacheSize = cacheSize
  }

  /** Value i, defused. */
  get(i: number): Value {
    let v = this.cache.get(i)
    if (v) {
      // Move it to the end, the most recently used.
      this.cache.delete(i)
      this.cache.set(i, v)
      return v
    }
    v = this.defuser.defuse(this.bsup.get(i))
    this.cache.set(i, v)
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!)
    return v
  }

  /** The first n values (or all of them if there are fewer). */
  head(n: number): Value[] {
    const out: Value[] = []
    for (let i = 0; i < Math.min(n, this.length); i++) out.push(this.get(i))
    return out
  }

  /**
   * Whether the values may have more than one shape, judged by their fused
   * types: they do if there's more than one, or if one has fusion values
   * inside (which mark where values differ).
   */
  get mixed(): boolean {
    return this.fusedTypes.length > 1 || this.fusedTypes.some((t) => hasFusion(t) || t.kind === "union")
  }
}
