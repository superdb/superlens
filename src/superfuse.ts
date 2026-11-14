// The Superfuse button's query: the current query with
// "aggregate superfuse(this)" added, so the results are replaced by their
// fused type.  It has no DOM code so it can be tested in Node.

export const SUPERFUSE = "aggregate superfuse(this)"

/** query with SUPERFUSE added to the end, or SUPERFUSE if query is empty. */
export function addSuperfuse(query: string): string {
  // A trailing semicolon would end the query before the new operator.
  const q = query.replace(/[\s;]+$/, "").trim()
  // The query without -- comments.  (A string containing "--" only makes
  // this look longer, which is harmless here.)
  const code = q.replace(/--.*$/gm, "").replace(/[\s;]+$/, "").trim()
  if (code === "") return q === "" ? SUPERFUSE : `${q}\n${SUPERFUSE}`
  // Superfusing a type again would just give <type>.
  if (/\bsuperfuse\(this\)$/.test(code)) return q
  // A -- comment would swallow anything after it on the same line.
  const sep = q.includes("\n") || q.includes("--") ? "\n| " : " | "
  return q + sep + SUPERFUSE
}
