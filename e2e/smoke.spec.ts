// Smoke tests of a built SuperLens in a browser (npm run test:e2e).  They
// check that the page loads the engine under its content security policy,
// runs queries, shows results, and downloads and reopens them.  They're
// meant to catch a build that's broken, e.g., by a change in super or
// super-ts, before it's deployed.  The expected values are what super
// gives for the same queries.

import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const SAMPLE_QUERY = "count() by type | sort count desc"
const SAMPLE_RESULTS = [
  '{type:"PushEvent",count:75}',
  '{type:"WatchEvent",count:39}',
  '{type:"PullRequestEvent",count:38}',
  '{type:"IssuesEvent",count:33}',
  '{type:"IssueCommentEvent",count:31}',
  '{type:"ForkEvent",count:14}',
  '{type:"CreateEvent",count:10}',
]

// Anything the page throws or logs as an error, such as a content security
// policy violation, fails the test.
let errors: string[] = []

async function open(page: Page) {
  await page.goto("./")
  await expect(page.locator("#engine-status")).toHaveText(/^SuperDB \S+ ready$/)
}

// Waits for a query to finish, failing with the page's message if it
// failed, and checks the status line (e.g., "7 values · 12 ms").
async function expectStatus(page: Page, status: RegExp) {
  const messages = page.locator("#messages")
  // Both match if a query that succeeds also shows a warning.
  await expect(page.locator("#status").filter({ hasText: status }).or(messages.filter({ hasText: /\S/ })).first()).toBeVisible()
  expect((await messages.innerText()).trim()).toBe("")
  await expect(page.locator("#status")).toHaveText(status)
}

async function supLines(page: Page) {
  await page.locator('.tabs [data-view="text"]').click()
  return page.locator(".tline")
}

async function download(page: Page, format: string) {
  await page.locator("#export-select").selectOption(format)
  const download = page.waitForEvent("download")
  await page.locator("#download-button").click()
  return download
}

test.beforeEach(async ({ page }) => {
  errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await open(page)
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

test("the sample data opens in the table", async ({ page }) => {
  await page.locator("#sample-button").click()
  await expect(page.locator("#query")).toHaveValue(SAMPLE_QUERY)
  await expectStatus(page, /^7 values · /)
  await expect(page.locator('.tabs [data-view="table"]')).toHaveClass(/\bactive\b/)
  await expect(page.locator(".th:not(.index)")).toHaveText(["type", "count"])
  await expect(page.locator(".trow")).toHaveCount(7)
  await expect(page.locator(".trow").first()).toContainText("PushEvent")
  await expect(await supLines(page)).toHaveText(SAMPLE_RESULTS)
})

test("values of different shapes download as NDJSON", async ({ page }) => {
  const json = '{"a":1}\n{"b":"x"}\n{"a":2,"c":[1,"y"]}\n'
  await page.locator("#file-input").setInputFiles({ name: "mixed.json", mimeType: "application/json", buffer: Buffer.from(json) })
  await expectStatus(page, /^3 values · 3 shapes · /)
  await expect(await supLines(page)).toHaveText(["{a:1}", '{b:"x"}', '{a:2,c:[1,"y"]}'])
  const file = await download(page, "json")
  expect(file.suggestedFilename()).toBe("results.ndjson")
  expect(readFileSync(await file.path(), "utf8")).toBe(json)
})

// Parquet is written by the engine's export and read back in pieces from
// the browser's File, so this checks both.
test("results downloaded as Parquet open again", async ({ page }) => {
  await page.locator("#sample-button").click()
  await expectStatus(page, /^7 values · /)
  const file = await download(page, "parquet")
  expect(file.suggestedFilename()).toBe("results.parquet")
  const parquet = readFileSync(await file.path())

  await open(page)
  await page.locator("#query").fill("")
  await page.locator("#file-input").setInputFiles({ name: "results.parquet", mimeType: "application/octet-stream", buffer: parquet })
  await expectStatus(page, /^7 values · /)
  await expect(await supLines(page)).toHaveText(SAMPLE_RESULTS)
})

test("a query error is shown", async ({ page }) => {
  await page.locator("#query").fill("count(")
  await page.locator("#query").press("Enter")
  await expect(page.locator("#messages")).toContainText("parse error")
})
