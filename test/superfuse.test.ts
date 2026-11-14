import { test } from "node:test"
import assert from "node:assert/strict"
import { addSuperfuse } from "../src/superfuse.ts"

test("superfuse is added to the end of the query", () => {
  assert.equal(addSuperfuse(""), "aggregate superfuse(this)")
  assert.equal(addSuperfuse("  \n "), "aggregate superfuse(this)")
  assert.equal(addSuperfuse("count() by type"), "count() by type | aggregate superfuse(this)")
  assert.equal(addSuperfuse("where x > 1;  "), "where x > 1 | aggregate superfuse(this)")
  assert.equal(addSuperfuse("from 'a.json'\n| head 5\n"), "from 'a.json'\n| head 5\n| aggregate superfuse(this)")
  assert.equal(addSuperfuse("head 5 -- first few"), "head 5 -- first few\n| aggregate superfuse(this)")
  assert.equal(addSuperfuse("SELECT a FROM 'a.json'"), "SELECT a FROM 'a.json' | aggregate superfuse(this)")
})

test("superfuse isn't added twice", () => {
  assert.equal(addSuperfuse("head 5 | aggregate superfuse(this)"), "head 5 | aggregate superfuse(this)")
  assert.equal(addSuperfuse("superfuse(this)\n"), "superfuse(this)")
})

test("superfuse looks past comments", () => {
  assert.equal(addSuperfuse("-- try things here"), "-- try things here\naggregate superfuse(this)")
  assert.equal(addSuperfuse("head 5 -- not superfuse(this)"), "head 5 -- not superfuse(this)\n| aggregate superfuse(this)")
  assert.equal(addSuperfuse("superfuse(this) -- done"), "superfuse(this) -- done")
})
