// The Superfuse button's query: the current query with
// "aggregate superfuse(this)" added, so the results are replaced by their
// fused type.  It has no DOM code so it can be tested in Node.

import { addOperator } from "./query.ts"

export const SUPERFUSE = "aggregate superfuse(this)"

/** query with SUPERFUSE added to the end, or SUPERFUSE if query is empty. */
export function addSuperfuse(query: string): string {
  // Superfusing a type again would just give <type>.
  return addOperator(query, SUPERFUSE, /\bsuperfuse\(this\)$/)
}
