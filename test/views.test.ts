import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ArrayValue,
  IntValue,
  RecordValue,
  StringValue,
  TypeContext,
  TypeInt64,
  TypeMissing,
  TypeNull,
  TypeString,
  TypeType,
  TypeUint16,
  TypeValue,
  type Type,
  type Value,
} from "@superdb/super-ts"
import { TreeModel, PAGE, openText, typeText, typeTitle, valueTitle } from "../src/views/tree.ts"
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

/** The rows as text, with open rows as the inspector shows them or as "<open>". */
function lines(model: TreeModel, asShown = true): string[] {
  return model.rows().map((r) => {
    const pad = "  ".repeat(r.depth)
    if (r.kind === "close") return pad + r.text
    if (r.kind === "more") return `${pad}... ${r.shown}/${r.total}`
    const key = r.key === undefined ? "" : `${r.key}: `
    if (r.expanded) return pad + key + (asShown ? openText(r) : "<open>")
    return pad + key + (r.kind === "type" ? typeText(r) : r.value.toString())
  })
}

/** The rows joined back into one line of SUP. */
function rejoin(model: TreeModel): string {
  let out = ""
  let afterOpen = true
  for (const r of model.rows()) {
    if (r.kind === "more") throw new Error("rows were paged")
    if (r.kind === "close") {
      out += r.text
      afterOpen = false
      continue
    }
    if (r.key !== undefined) out += (afterOpen ? "" : ",") + r.key + ":"
    out += r.expanded ? openText(r) : r.kind === "type" ? typeText(r) : r.value.toString()
    afterOpen = r.expanded
  }
  return out
}

const field = (name: string, type: Type) => ({ name, type })
const typeValue = (t: Type) => new TypeValue(TypeType, t)

test("tree expands within a budget and toggles", () => {
  const v = rec([
    ["a", int(1)],
    ["b", rec([["c", str("x")]])],
  ])
  const m = new TreeModel([v])
  m.expandWithin(100)
  assert.deepEqual(lines(m, false), ["<open>", "  a: 1", "  b: <open>", '    c: "x"', "  }", "}"])
  m.toggle("0/1")
  assert.deepEqual(lines(m, false), ["<open>", "  a: 1", '  b: {c:"x"}', "}"])
  m.collapseAll()
  assert.deepEqual(lines(m, false), ['{a:1,b:{c:"x"}}'])
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

test("type values expand into the fields of their types", () => {
  // Like the output of superfuse: fields that are sometimes missing are
  // fusion(missing|{...}), and the wrappers stay on the rows that open and
  // close the record inside.
  const label = ctx.record([field("name", TypeString)])
  const t = ctx.record([
    field("id", TypeString),
    field("actor", ctx.record([field("id", TypeInt64), field("login", TypeString)])),
    field(
      "payload",
      ctx.record([
        field("number", ctx.fusion(ctx.union([TypeInt64, TypeMissing]))),
        field("review", ctx.fusion(ctx.union([TypeMissing, ctx.record([field("id", TypeInt64)])]))),
        field("labels", ctx.fusion(ctx.array(ctx.fusion(label)))),
        field("empty", ctx.record([])),
      ]),
    ),
    field("note", ctx.option(TypeString)),
  ])
  const m = new TreeModel([typeValue(t)])
  m.expandWithin(100)
  assert.deepEqual(lines(m), [
    "<{",
    "  id: string",
    "  actor: {",
    "    id: int64",
    "    login: string",
    "  }",
    "  payload: {",
    "    number: fusion(int64|missing)",
    "    review: fusion(missing|{",
    "      id: int64",
    "    })",
    "    labels: fusion([fusion({",
    "      name: string",
    "    })])",
    "    empty: {}",
    "  }",
    "  note?: string",
    "}>",
  ])
  const rows = m.rows()
  assert.equal(rows[0].kind, "value")
  assert.ok(rows.slice(1).every((r) => r.kind === "type" || r.kind === "close"))
  m.collapseAll()
  assert.deepEqual(lines(m), [
    "<{id:string,actor:{id:int64,login:string},payload:{number:fusion(int64|missing),review:fusion(missing|{id:int64}),labels:fusion([fusion({name:string})]),empty:{}},note?:string}>",
  ])
  // A field's type collapses to its SUP text.
  m.toggle("0")
  assert.deepEqual(lines(m)[3], "  payload: {number:fusion(int64|missing),review:fusion(missing|{id:int64}),labels:fusion([fusion({name:string})]),empty:{}}")
})

test("type values in records expand within the budget", () => {
  const t = ctx.record([field("a", ctx.record([field("b", ctx.record([field("c", TypeInt64)]))]))])
  const v = rec([["t", typeValue(t)]])
  const m = new TreeModel([v])
  m.expandWithin(100)
  assert.deepEqual(lines(m), ["{", "  t: <{", "    a: {", "      b: {", "        c: int64", "      }", "    }", "  }>", "}"])
  m.expandWithin(4)
  assert.deepEqual(lines(m), ["{", "  t: <{a:{b:{c:int64}}}>", "}"])
})

test("a union with more than one expandable member lists its members", () => {
  const x = ctx.record([field("x", TypeInt64)])
  const y = ctx.record([field("y", TypeString)])
  // One expandable member: the others are written around it.
  const one = ctx.fusion(ctx.union([TypeNull, TypeMissing, x, ctx.array(TypeInt64)]))
  // Two: each member is a child, after a "|" past the first.
  const two = ctx.union([x, ctx.array(y)])
  const m = new TreeModel([typeValue(ctx.record([field("one", one), field("two", two)]))])
  m.expandWithin(100)
  assert.deepEqual(lines(m), [
    "<{",
    "  one: fusion(null|missing|{",
    "    x: int64",
    "  }|[int64])",
    "  two: (",
    "    {",
    "      x: int64",
    "    }",
    "    |[{",
    "      y: string",
    "    }]",
    "  )",
    "}>",
  ])
  // A type value that is itself such a union needs no parentheses.
  const top = new TreeModel([typeValue(two)])
  top.expandWithin(100)
  assert.deepEqual(lines(top)[0], "<")
  assert.deepEqual(lines(top).at(-1), ">")
})

test("named types open to their definition", () => {
  const port = ctx.named("port", TypeUint16)
  const addr = ctx.named("addr", ctx.record([field("p", port)]))
  const m = new TreeModel([typeValue(ctx.record([field("a", addr), field("b", addr)]))])
  m.expandWithin(100)
  assert.deepEqual(lines(m), ["<{", "  a: addr={", "    p: port", "  }", "  b: addr={", "    p: port", "  }", "}>"])
  const p = m.rows()[2]
  assert.ok(p.kind === "type" && !p.expandable)
  if (p.kind === "type") assert.equal(typeTitle(p), "type port=uint16")
  // A type value that is a named type opens too, and hovering over one that
  // doesn't shows its definition.
  const top = new TreeModel([typeValue(addr), typeValue(port)])
  top.expandWithin(100)
  assert.deepEqual(lines(top), ["<addr={", "  p: port", "}>", "<port>"])
  assert.equal(valueTitle(typeValue(port)), "type port=uint16")
  // A union of records after the "=" is in parentheses.
  const both = ctx.named("both", ctx.union([ctx.record([field("x", TypeInt64)]), ctx.record([field("y", TypeString)])]))
  const b = new TreeModel([typeValue(both)])
  b.expandWithin(100)
  assert.deepEqual(lines(b), ["<both=(", "  {", "    x: int64", "  }", "  |{", "    y: string", "  }", ")>"])
})

test("named types that refer to themselves", () => {
  // type t=[t]|null has no record to open.
  const t = ctx.namedPlaceholder("t")
  ctx.bindNamed(t, ctx.union([ctx.array(t), TypeNull]))
  const m = new TreeModel([typeValue(ctx.record([field("r", t)]))])
  m.expandWithin(100)
  assert.deepEqual(lines(m), ["<{", "  r: t", "}>"])
  // type node={v:int64,next:node|null} opens one level per click, and
  // Expand all stops at its depth limit.
  const node = ctx.namedPlaceholder("node")
  ctx.bindNamed(node, ctx.record([field("v", TypeInt64), field("next", ctx.union([node, TypeNull]))]))
  const n = new TreeModel([typeValue(node)])
  n.expandWithin(100_000, 64)
  assert.deepEqual(lines(n).slice(0, 4), ["<node={", "  v: int64", "  next: node={", "    v: int64"])
  assert.ok(n.rows().length < 1000)
})

test("type rows quote field names and hover without the union bar", () => {
  const t = ctx.record([
    field("a b", TypeInt64),
    field("", TypeString),
    field("x?", TypeInt64),
    field("x", ctx.option(TypeInt64)),
    field("u", ctx.union([ctx.record([field("p", TypeInt64)]), TypeInt64, ctx.array(ctx.record([field("q", TypeInt64)]))])),
  ])
  const m = new TreeModel([typeValue(t)])
  m.expandWithin(3)
  m.toggle("0")
  m.toggle("0/4")
  assert.deepEqual(lines(m), [
    "<{",
    '  "a b": int64',
    '  "": string',
    '  "x?": int64',
    "  x?: int64",
    "  u: (",
    "    {p:int64}",
    "    |int64",
    "    |[{q:int64}]",
    "  )",
    "}>",
  ])
  const member = m.rows()[7]
  assert.ok(member.kind === "type")
  if (member.kind === "type") assert.equal(typeTitle(member), "int64")
})

test("fully expanded type rows read as the type's SUP text", () => {
  // Every wrapper the tree writes around a record, checked against super-ts's
  // own formatting.
  const r = (name: string) => ctx.record([field(name, TypeInt64), field("s", TypeString)])
  const types = [
    ctx.record([
      field("arr", ctx.array(r("a"))),
      field("set", ctx.set(r("b"))),
      field("map", ctx.map(TypeString, r("c"))),
      field("err", ctx.error(r("d"))),
      field("fus", ctx.fusion(ctx.union([TypeMissing, r("e")]))),
      field("opt", ctx.option(r("f"))),
      field("arropt", ctx.array(ctx.option(r("g")))),
      field("after", ctx.union([r("h"), TypeNull])),
      field("around", ctx.fusion(ctx.union([TypeNull, TypeMissing, r("i"), ctx.array(TypeInt64)]))),
      field("deep", ctx.fusion(ctx.array(ctx.fusion(ctx.union([TypeMissing, ctx.record([field("in", r("j"))])]))))),
      field("odd name", r("k")),
    ]),
    ctx.array(ctx.union([TypeInt64, r("l")])),
    ctx.union([r("m"), ctx.array(r("n"))]),
  ]
  for (const t of types) {
    const v = typeValue(t)
    const m = new TreeModel([v])
    m.expandWithin(100_000, 64)
    assert.equal(rejoin(m), v.toString())
    assert.ok(m.rows().length > 3)
  }
})
