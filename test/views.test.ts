import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ArrayValue,
  IntValue,
  RecordValue,
  StringValue,
  TypeContext,
  TypeInt64,
  TypeString,
  type Value,
} from "@superdb/super-ts"
import { TreeModel, PAGE } from "../src/views/tree.ts"
import { CellLookup, buildColumns, shapeCounts } from "../src/views/columns.ts"
import { cellText } from "../src/views/cells.ts"
import { bestView } from "../src/views/choose.ts"

const ctx = new TypeContext()
const int = (n: number) => new IntValue(TypeInt64, n)
const str = (s: string) => new StringValue(TypeString, s)
function rec(fields: [string, Value][]): RecordValue {
  return new RecordValue(
    ctx.record(fields.map(([name, v]) => ({ name, type: v.type }))),
    fields.map(([, v]) => v),
  )
}

function describe(model: TreeModel): string[] {
  return model.rows().map((r) => {
    const pad = "  ".repeat(r.depth)
    if (r.kind === "close") return pad + r.text
    if (r.kind === "more") return `${pad}... ${r.shown}/${r.total}`
    const key = r.key === undefined ? "" : `${r.key}: `
    return pad + key + (r.expanded ? "<open>" : r.value.toString())
  })
}

test("tree expands within a budget and toggles", () => {
  const v = rec([
    ["a", int(1)],
    ["b", rec([["c", str("x")]])],
  ])
  const m = new TreeModel([v])
  m.expandWithin(100)
  assert.deepEqual(describe(m), ["<open>", "  a: 1", "  b: <open>", '    c: "x"', "  }", "}"])
  m.toggle("0/1")
  assert.deepEqual(describe(m), ["<open>", "  a: 1", '  b: {c:"x"}', "}"])
  m.collapseAll()
  assert.deepEqual(describe(m), ['{a:1,b:{c:"x"}}'])
  // A budget too small for the children leaves the value collapsed.
  m.expandWithin(2)
  assert.equal(m.rows().length, 1)
})

test("tree pages large containers", () => {
  const items = Array.from({ length: PAGE + 50 }, (_, k) => int(k))
  const m = new TreeModel([new ArrayValue(ctx.array(TypeInt64), items)])
  m.toggle("0")
  let rows = m.rows()
  assert.equal(rows.length, 1 + PAGE + 1 + 1)
  const more = rows[PAGE + 1]
  assert.equal(more.kind, "more")
  if (more.kind === "more") m.showMore(more.parent)
  rows = m.rows()
  assert.equal(rows.length, 1 + PAGE + 50 + 1)
})

test("columns merge shapes and flatten nested records", () => {
  const a = rec([
    ["id", int(1)],
    ["user", rec([["name", str("ada")]])],
  ])
  const b = rec([
    ["id", int(2)],
    ["extra", str("x")],
  ])
  const values = [a, b, str("loose")]
  const cols = buildColumns([...shapeCounts(values).keys()])
  assert.deepEqual(
    cols.map((c) => c.label),
    ["id", "user.name", "extra", "this"],
  )
  const lookup = new CellLookup(cols)
  const cells = values.map((v) => cols.map((_, k) => lookup.cell(v, k)?.toString() ?? "-"))
  assert.deepEqual(cells, [
    ["1", '"ada"', "-", "-"],
    ["2", "-", '"x"', "-"],
    ["-", "-", "-", '"loose"'],
  ])
})

test("cell text and view choice", () => {
  assert.equal(cellText(str("hi")), "hi")
  assert.equal(cellText(int(-3)), "-3")
  assert.equal(cellText(rec([["a", int(1)]])), "{a:1}")
  assert.equal(bestView([rec([["a", int(1)]]), rec([["a", int(2)]])], 1), "table")
  assert.equal(bestView([rec([["a", int(1)]])], 1), "inspector")
  assert.equal(bestView([int(1), int(2)], 1), "inspector")
})
