# SuperLens

SuperLens is a web app for exploring data files with
[SuperSQL](https://superdb.org/super-sql/intro). You open or drop in JSON,
CSV, Parquet, and other formats, type a query, and browse the results in a
table, a tree inspector, or as [SUP](https://superdb.org/formats/sup) text.
It's meant to be hosted at **lens.superdb.org**.

The whole [SuperDB](https://superdb.org/) query engine runs inside your
browser, compiled to WebAssembly.

## Your data stays on your computer

SuperLens has no server-side component. The site is a set of static files:
HTML, JavaScript, CSS, and the query engine (`super.wasm`).

* **Files are never uploaded.** When you open or drop a file, the browser
  reads it into memory and hands it to the query engine in the same tab.
  Queries run locally, and the results are rendered locally.
* **The page can't send your data anywhere.** Its content security policy
  (set in `index.html`, and also as an HTTP header by the dev server and
  `public/_headers`) only allows connections to the site itself
  (`connect-src 'self'`). The only things it fetches from there are its own
  code and the engine.
* **Nothing is kept.** Closing or reloading the tab discards your files and
  results. The only things saved, in the browser's local storage, are a few
  preferences: the last query, the input format, the result limit, and the
  view.
* **Downloads are made locally.** "Download" builds the SUP file in the page.

## Using SuperLens

* **Open files** with the *Open files…* button, or drop them anywhere on the
  page. You can open several files; dropping a file with the same name
  replaces it. Remove files with the × on their chips.
* **Formats** are detected automatically: JSON (including NDJSON), CSV, TSV,
  Parquet, SUP, BSUP, Arrow IPC streams, Zeek logs, and plain lines of text.
  If detection guesses wrong, choose the format from the *Format* menu (it
  applies to every file).
* **With no query, everything is shown.** Every value in every file appears,
  so a single JSON document shows up as one value in the inspector.
* **Type a query** and press Enter to run it (Shift+Enter adds a new line).
  A query runs over all of the open files, e.g. `count() by type`,
  `where status >= 500 | sort -r time`, or `select name, count(*) from ...`.
  To query one file, name it: `from 'events.json' | head 10`. A query that
  starts with `from`, or that has its own SQL `FROM` clause, reads only the
  files it names. See the
  [SuperSQL reference](https://superdb.org/super-sql/intro) for the
  language.
* **Views:**
  * **Table** shows a row per value and a column per field. Nested records
    are flattened into dotted column names. When values have different
    shapes, their columns are merged, and a hatched cell marks a field that
    a row doesn't have. Drag a column's right edge to resize it. Click a row
    (or use the arrow keys) to inspect it in the side panel, where you can
    copy it as SUP or JSON.
  * **Inspector** shows values as an expandable tree. Small results open
    fully, larger ones partially. Use *Expand all* and *Collapse all*, or
    click a row to toggle it.
  * **SUP** shows each value as a line of SUP. You can copy all of the lines
    or download them as `results.sup`.

  SuperLens picks the table for a set of records and the inspector for
  anything else. Once you pick a view, it sticks.
* **Show** limits how many values are displayed (100,000 by default). When a
  result is cut off, a warning says so. Choose *all* to remove the limit;
  very large results use a lot of memory.
* **Stop** cancels a running query. It restarts the engine, which takes a
  moment.

## How it works

```
 ┌─────────────── browser tab ───────────────────────────────────────────┐
 │                                                                       │
 │  app (src/app.ts)              engine worker (src/engine/worker.ts)   │
 │  ┌──────────────────┐  files   ┌───────────────────────────────────┐  │
 │  │ files, query box │ ───────► │ super.wasm (wasm/main.go)          │  │
 │  │                  │  query   │  SuperDB compiler + runtime        │  │
 │  │ table, inspector │ ◄─────── │  reads the files from memory       │  │
 │  │ SUP views        │   BSUP   │  writes results as BSUP            │  │
 │  └──────────────────┘          └───────────────────────────────────┘  │
 │     ▲ decodes BSUP into typed values with super-ts                    │
 └───────────────────────────────────────────────────────────────────────┘
```

* **The engine** (`wasm/main.go`) is a small Go program built against your
  checkout of the [super repo](https://github.com/superdb/super). It's
  adapted from the playground in super's book (`book/super-example`) with
  these changes:
  * Inputs are a list of named files held in memory, so Parquet (which
    needs random access) works and queries can refer to files by name.
  * Files are loaded into the engine once and reused by later queries.
  * Results are written as BSUP bytes, the same format and control messages
    the SuperDB service uses, instead of as text.
  * Fusion values are defused, as the `super` command does by default.
  * There's a result limit that sends a warning when it's reached.
* **The worker** loads the engine and runs queries off the main thread, so
  the page stays responsive. Stopping a query replaces the worker, reusing
  the already-compiled engine.
* **[super-ts](https://github.com/superdb/super-ts)** decodes the BSUP
  results into typed values (`QueryResult`, `decodeBSUPStream`) and formats
  them as SUP. The views use its types and values directly: shapes for table
  columns, `RecordValue.fieldAt` for cells, and `toString()` for SUP.
* **The views** (`src/views/`) are written in plain TypeScript and DOM. They're
  modeled on zui's table and inspector and are virtualized, so they only
  render the rows on screen and can scroll through hundreds of thousands
  of values.

There's no bundler or framework. The build compiles TypeScript to ES modules
that browsers load directly, and the site has no runtime dependencies.

## Building

### Prerequisites

* **Go 1.27 or later**, the version super's `go.mod` requires, to build the
  engine.
* **Node.js 22.18 or later**, for the build scripts and tests.
* Checkouts of **super** and **super-ts** next to this repo:

  ```
  ~/repo/super       (github.com/superdb/super)
  ~/repo/super-ts    (github.com/superdb/super-ts)
  ~/repo/superlens   (this repo)
  ```

  Set `SUPER_REPO` and `SUPER_TS` to use checkouts elsewhere.

### Build and run

```sh
npm install          # installs TypeScript (the only dependency, used at build time)
npm run build        # builds the engine and the app into dist/
npm run serve        # serves dist/ at http://localhost:8080/
```

`npm run build` does the following:

1. Builds `dist/super.wasm` by compiling `wasm/main.go` from inside the super
   repo (`scripts/build-wasm.sh`), so it uses that checkout and its `go.mod`.
   It also copies Go's `wasm_exec.js` into `dist/`. This step takes a minute
   or so and, the first time, needs the network to download Go modules.
2. Compiles super-ts from `SUPER_TS` into `dist/vendor/super-ts/`.
3. Compiles the app from `src/` into `dist/app/`, pointing its super-ts
   imports at the vendored copy.
4. Copies `public/` (the HTML, CSS, icon, sample data, and `_headers`) into
   `dist/`.

Other scripts:

| command | what it does |
|---|---|
| `npm run dev` | builds the app (and the engine, if `dist/super.wasm` is missing), recompiles on changes, and serves at :8080. Reload the page to see changes. |
| `npm run build:app` | rebuilds the app and super-ts without rebuilding the engine |
| `npm run build:wasm` | rebuilds just the engine, e.g., after pulling super |
| `npm run check` | type checks the app (run a build first so the super-ts types are in `dist/vendor`) |
| `npm test` | runs the unit tests (tree, columns, cell formatting) against the super-ts sources |
| `npm run clean` | removes `dist/` |

Examples:

```sh
SUPER_REPO=~/src/super npm run build:wasm      # use another super checkout
SUPER_TS=~/src/super-ts npm run build:app      # use another super-ts checkout
npm run serve -- --port 9000
```

## Hosting

`dist/` is a static site that any static host can serve, such as Cloudflare
Pages, Netlify, S3 with CloudFront, or GitHub Pages. To deploy, upload the
contents of `dist/`. Some things to configure:

* **Headers.** `public/_headers` (copied to `dist/_headers`) sets the content
  security policy, `nosniff`, and the WebAssembly content type for hosts
  that read that file, such as Cloudflare Pages and Netlify. On other hosts,
  set these headers yourself. The policy is also in `index.html` as a
  `<meta>` tag, but the HTTP header covers the worker too.
* **`super.wasm` must be served as `application/wasm`.**
* **Compression.** `super.wasm` is large (about 90 MB uncompressed, 16 MB
  with gzip), so make sure the host serves it compressed with gzip or
  brotli. Browsers cache it after the first visit.
* **No server code and no cookies are needed.** SuperLens never calls an API.

## Project layout

```
wasm/main.go              the engine (Go, built against the super repo)
src/main.ts               entry point
src/app.ts                the app: files, query, views, status
src/engine/engine.ts      runs queries in the worker and decodes results (super-ts)
src/engine/worker.ts      loads super.wasm and runs queries off the main thread
src/engine/protocol.ts    messages between the app and the worker
src/views/table.ts        the table view
src/views/columns.ts      table columns merged across shapes
src/views/inspector.ts    the inspector view
src/views/tree.ts         the inspector's tree model
src/views/text.ts         the SUP view
src/views/virtual.ts      the virtualized list behind all three views
src/views/cells.ts        value text, colors, and JSON
src/views/choose.ts       picks the default view for a result
public/                   index.html, style.css, favicon, sample data, _headers
scripts/                  build, dev server, and wasm build scripts
test/                     unit tests (node --test)
```

## Troubleshooting

* **"The query engine failed to load."** Check that `dist/super.wasm` and
  `dist/wasm_exec.js` exist and are served as `application/wasm` and
  JavaScript. `wasm_exec.js` must come from the same Go version that built
  `super.wasm`; `npm run build:wasm` copies the matching one.
* **The wasm build fails.** The engine compiles against your super checkout.
  If super's internal APIs have changed, `wasm/main.go` may need updating.
  It uses `parser.ParseText`, `storage.NewInternalEngine`,
  `exec.NewEnvironment`, `compiler.NewCompilerWithEnv`,
  `runtime.CompileQuery`, `queryio.NewBSUPWriter`, and
  `expr.NewSuperDefuse`.
* **A file is read in the wrong format.** Pick the format from the *Format*
  menu.
* **The page gets slow with huge results.** Lower *Show*, or aggregate in the
  query (`count() by ...`, `head`, `where`).
