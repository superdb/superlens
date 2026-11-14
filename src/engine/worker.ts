// The engine worker runs SuperDB (compiled to WebAssembly) off the main
// thread so a long query doesn't freeze the page.  Files are read here, in
// the browser, and copied into the engine's memory; nothing is sent over the
// network.  The only fetches are for the engine itself (super.wasm and
// wasm_exec.js), from the same site as the app.

import type { FromWorker, ToWorker } from "./protocol.ts"

interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
  /** Called by wasm_exec.js when the Go program exits. */
  exit: (code: number) => void
}

interface Input {
  name: string
  data: Uint8Array
}

interface SuperLensWasm {
  setInputs(inputs: Input[]): number
  run(args: {
    program: string
    useLoaded: boolean
    inputFormat: string
    outputFormat: string
    limit: number
  }): Promise<Uint8Array | string>
  version(): string
}

type GoGlobal = typeof globalThis & {
  Go?: new () => GoRuntime
  __go_wasm__?: Record<string, unknown>
  fs?: { writeSync(fd: number, buf: Uint8Array): number }
}

const g = globalThis as GoGlobal
let api: SuperLensWasm | undefined

// exited is set when the Go program exits.  The engine's main never returns,
// so this means it crashed, e.g., because it ran out of memory (WebAssembly
// gives it at most 4 GB) or a goroutine panicked.  After that, wasm_exec.js
// can't call into Go, and its calls fail with errors that don't say what
// happened (e.g., "Cannot read properties of undefined (reading 'exports')").
let exited = false

// Go writes to stdout and stderr through the fs object that wasm_exec.js
// sets up, which logs each line to the console.  The start of each
// request's output is kept here so that if Go crashes, the app can say why.
// When Go crashes, it says why first and then prints the stack of every
// goroutine, which can be hundreds of megabytes (e.g., when it runs out of
// memory while encoding many columns at once).  Logging all of that takes
// the browser minutes, so only the start of the output is logged.  The
// limit also keeps a bug report short enough for a GitHub issue.
const maxOutput = 32 * 1024
let output = ""
let outputDropped = false

function captureOutput() {
  const fs = g.fs
  if (!fs) return
  const writeSync = fs.writeSync.bind(fs)
  const decoder = new TextDecoder()
  fs.writeSync = (fd, buf) => {
    if (output.length < maxOutput) {
      output += decoder.decode(buf, { stream: true })
      return writeSync(fd, buf)
    }
    if (!outputDropped) {
      outputDropped = true
      console.log("(SuperLens dropped the rest of the query engine's output)")
    }
    return buf.length
  }
}

// crashed tells the app that the Go program exited or is broken, quoting
// what Go printed from its first line about the crash (e.g., "fatal error:
// out of memory", which "runtime: out of memory: ..." precedes, or
// "panic: ...").  If Go printed nothing, err (see isBroken) says what failed.
function crashed(err?: unknown) {
  if (exited) return
  exited = true
  const start = output.search(/^(runtime: |fatal error: |panic: )/m)
  let text = (start >= 0 ? output.slice(start) : output).trim()
  if (outputDropped) text += "\n... (the rest was dropped)"
  if (!text && err instanceof Error) text = `${err.name}: ${err.message}`
  post({ type: "crashed", outOfMemory: /out of memory/.test(text), output: text })
}

// isBroken is true for an error that leaves the Go program unusable even
// though it hasn't exited: a WebAssembly trap, such as "memory access out of
// bounds", or the browser's own stack overflow (a RangeError, or in Firefox,
// "InternalError: too much recursion").  Go can't recover from these, and a
// later call may fail in a confusing way (e.g., "fatal error: bad sweepgen
// in refill"), so they're crashes.  (A runaway recursion can end in either
// of these or in a fatal error from Go, from one run to the next.)  Errors
// from queries come from Go as plain Errors.  Only errors from calls into Go
// should be checked, since the worker's own code can throw a RangeError
// (e.g., when it can't allocate memory for a file).
function isBroken(e: unknown): boolean {
  return (
    e instanceof WebAssembly.RuntimeError ||
    e instanceof RangeError ||
    (e instanceof Error && e.name === "InternalError")
  )
}

// An error like that can also escape from the Go program's own callbacks,
// or from starting it (go.run).  Once the Go program has crashed, errors that
// the dead program causes would reach the app as worker errors, so they're
// dropped.  The crashed message covers them.
self.addEventListener("error", (ev) => {
  if (isBroken(ev.error)) crashed(ev.error)
  if (exited) ev.preventDefault()
})
self.addEventListener("unhandledrejection", (ev) => {
  if (isBroken(ev.reason)) crashed(ev.reason)
  if (exited) ev.preventDefault()
})

// failed reports an error from a request, unless it means that the engine
// crashed.
function failed(id: number, e: unknown) {
  if (isBroken(e)) crashed(e)
  else if (!exited) post({ type: "error", id, message: errorMessage(e) })
}

function post(msg: FromWorker, transfer: Transferable[] = []) {
  ;(self as unknown as Worker).postMessage(msg, transfer)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function fetchWithProgress(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`can't load ${url}: ${res.status} ${res.statusText}`)
  // When the response is compressed, Content-Length is the compressed size,
  // so use the uncompressed size if the server says what it is (as
  // scripts/serve.mjs does) and otherwise show indeterminate progress.
  const encoded = res.headers.get("Content-Encoding")
  const total = Number(
    res.headers.get("X-Uncompressed-Length") ?? (encoded ? 0 : (res.headers.get("Content-Length") ?? 0)),
  )
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  let last = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    const now = Date.now()
    if (now - last > 50) {
      post({ type: "progress", loaded, total })
      last = now
    }
  }
  post({ type: "progress", loaded, total: Math.max(total, loaded) })
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// Go's wasm_exec.js stubs out the process object in browsers, and its stub
// has no working directory, so a query's relative file names (from
// 'data.json') can't be resolved.  This stub is the same except that the
// working directory is the root, where the inputs are registered.
function stubProcess() {
  const enosys = () => Object.assign(new Error("not implemented"), { code: "ENOSYS" })
  ;(globalThis as Record<string, unknown>).process ??= {
    getuid: () => -1,
    getgid: () => -1,
    geteuid: () => -1,
    getegid: () => -1,
    getgroups: () => {
      throw enosys()
    },
    pid: -1,
    ppid: -1,
    umask: () => {
      throw enosys()
    },
    cwd: () => "/",
    chdir: () => {
      throw enosys()
    },
  }
}

async function load(req: Extract<ToWorker, { type: "load" }>) {
  stubProcess()
  await import(req.execURL)
  if (!g.Go) throw new Error("wasm_exec.js did not define Go")
  captureOutput()
  // golang-wasm (used by the engine's main) publishes its functions on
  // __go_wasm__ and calls __wrapper__ to adapt them.
  g.__go_wasm__ = {
    __wrapper__:
      (fn: (...args: unknown[]) => { error?: unknown; result?: unknown }) =>
      (...args: unknown[]) => {
        const r = fn(...args)
        if (r.error instanceof Error) throw r.error
        return r.result
      },
  }
  const module = req.module ?? (await WebAssembly.compile(await fetchWithProgress(req.wasmURL)))
  const go = new g.Go()
  go.exit = () => crashed()
  const instance = await WebAssembly.instantiate(module, go.importObject)
  void go.run(instance)
  const exports = g.__go_wasm__ as Record<string, unknown>
  for (let k = 0; typeof exports.run !== "function"; k++) {
    if (exited) return
    if (k > 1000) throw new Error("the engine did not start")
    await new Promise((r) => setTimeout(r, 5))
  }
  api = exports as unknown as SuperLensWasm
  // Hand the compiled module back so a replacement worker (after a query is
  // stopped) can start without compiling it again.
  try {
    post({ type: "ready", version: api.version(), module })
  } catch {
    post({ type: "ready", version: api.version() })
  }
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const req = ev.data
  if (exited) {
    // The app replaces the worker when it crashes, so this shouldn't happen.
    if (req.type === "load") post({ type: "load-error", message: "the query engine has stopped" })
    else post({ type: "error", id: req.id, message: "the query engine has stopped" })
    return
  }
  // Keep only the output of this request, in case it crashes.
  output = ""
  outputDropped = false
  switch (req.type) {
    case "load":
      try {
        await load(req)
      } catch (e) {
        if (!exited) post({ type: "load-error", message: errorMessage(e) })
      }
      return
    case "inputs": {
      // Reading the files can fail (e.g., a RangeError when one is too big
      // for the browser), but that doesn't mean the engine crashed.
      let inputs: Input[]
      try {
        inputs = await Promise.all(
          req.files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
        )
      } catch (e) {
        post({ type: "error", id: req.id, message: errorMessage(e) })
        return
      }
      try {
        api!.setInputs(inputs)
        post({ type: "inputs-done", id: req.id })
      } catch (e) {
        failed(req.id, e)
      }
      return
    }
    case "run":
      try {
        const start = performance.now()
        const out = await api!.run({
          program: req.program,
          useLoaded: true,
          inputFormat: req.format,
          outputFormat: "bsup",
          limit: req.limit,
        })
        if (typeof out === "string") throw new Error("engine returned text instead of BSUP")
        post({ type: "result", id: req.id, bsup: out, elapsedMs: performance.now() - start }, [out.buffer])
      } catch (e) {
        failed(req.id, e)
      }
      return
  }
}
