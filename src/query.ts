// Adding an operator to the end of the user's query, for the Superfuse
// button and for downloads.  It has no DOM code so it can be tested in Node.

/**
 * query with op added to the end as another pipe stage, or op alone if the
 * query is empty.  If the query (ignoring comments) already matches ends,
 * it's returned unchanged.
 */
export function addOperator(query: string, op: string, ends: RegExp): string {
  // A trailing semicolon would end the query before the new operator.
  const q = query.replace(/[\s;]+$/, "").trim()
  // The query without -- comments.  (A string containing "--" only makes
  // this look longer, which is harmless here.)
  const code = q.replace(/--.*$/gm, "").replace(/[\s;]+$/, "").trim()
  if (code === "") return q === "" ? op : `${q}\n${op}`
  if (ends.test(code)) return q
  // A -- comment would swallow anything after it on the same line.
  const sep = q.includes("\n") || q.includes("--") ? "\n| " : " | "
  return q + sep + op
}
