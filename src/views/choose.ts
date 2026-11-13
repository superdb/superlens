import { recordOf, type Value } from "@superdb/super-ts"

export type ViewName = "table" | "inspector" | "text"

/**
 * The view that best fits a result when the user hasn't picked one: a
 * table for a set of records and the inspector for anything else, including
 * a single value (e.g., a whole JSON document).
 */
export function bestView(values: readonly Value[], shapes: number): ViewName {
  if (values.length <= 1) return "inspector"
  if (shapes > 50) return "inspector"
  return values.every((v) => recordOf(v.type) !== null) ? "table" : "inspector"
}
