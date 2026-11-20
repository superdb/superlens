import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_EXPORT_FORMAT, EXPORT_FORMATS, exportFormat, exportQuery } from "../src/export.ts"

const csv = exportFormat("csv")
const sup = exportFormat("sup")

test("export formats are found by name, with SUP as the default", () => {
  assert.equal(exportFormat("parquet").ext, "parquet")
  // SuperDB writes JSON as one value per line.
  assert.equal(exportFormat("json").label, "NDJSON")
  assert.equal(exportFormat("json").ext, "ndjson")
  assert.equal(exportFormat(null).name, DEFAULT_EXPORT_FORMAT)
  assert.equal(exportFormat("nope").name, "sup")
  // Only binary formats can't be copied, and only these need fuse.
  assert.deepEqual(
    EXPORT_FORMATS.filter((f) => f.binary).map((f) => f.name),
    ["arrows", "bsup", "parquet"],
  )
  assert.deepEqual(
    EXPORT_FORMATS.filter((f) => f.tabular).map((f) => f.name),
    ["arrows", "csv", "parquet", "tsv"],
  )
  // Only BSUP keeps fusion values, as in super.
  assert.deepEqual(
    EXPORT_FORMATS.filter((f) => f.fusion).map((f) => f.name),
    ["bsup"],
  )
  // The menu is in alphabetical order.
  const labels = EXPORT_FORMATS.map((f) => f.label)
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })))
})

test("tabular formats add fuse to the query", () => {
  assert.deepEqual(exportQuery("count() by type", sup), { query: "count() by type", fused: false })
  assert.deepEqual(exportQuery("count() by type", csv), { query: "count() by type | fuse", fused: true })
  assert.deepEqual(exportQuery("", csv), { query: "fuse", fused: true })
  assert.deepEqual(exportQuery("head 5; ", csv), { query: "head 5 | fuse", fused: true })
  assert.deepEqual(exportQuery("head 5 -- a few", csv), { query: "head 5 -- a few\n| fuse", fused: true })
  assert.deepEqual(exportQuery("SELECT a FROM 'a.json'", csv), { query: "SELECT a FROM 'a.json' | fuse", fused: true })
})

test("fuse isn't added twice", () => {
  assert.deepEqual(exportQuery("head 5 | fuse", csv), { query: "head 5 | fuse", fused: false })
  assert.deepEqual(exportQuery("fuse\n", csv), { query: "fuse", fused: false })
  assert.deepEqual(exportQuery("head 5\n| fuse -- done", csv), { query: "head 5\n| fuse -- done", fused: false })
  assert.deepEqual(exportQuery("head 5 |> fuse", csv), { query: "head 5 |> fuse", fused: false })
  // superfuse isn't fuse.
  assert.deepEqual(exportQuery("superfuse(this)", csv), { query: "superfuse(this) | fuse", fused: true })
})
