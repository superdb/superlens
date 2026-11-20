// The app's interface to the query engine, which runs in a worker.
//
// Results come back from the worker as BSUP, with fused values left fused,
// and are decoded here with super-ts as the views need them (see
// ResultSet).

import { TypeContext } from "@superdb/super-ts"
import { ResultSet } from "../results.ts"
import type { FromWorker, ToWorker } from "./protocol.ts"

export interface QueryOutcome {
  results: ResultSet
  /** Time spent running the query in the engine. */
  elapsedMs: number
  /** Time spent reading the results' frames (their values are decoded later). */
  decodeMs: number
}

export interface EngineOptions {
  wasmURL: string
  execURL: string
  workerURL: string | URL
  onProgress?: (loaded: number, total: number) => void
}

/** Thrown by run when the query is stopped (or superseded). */
export class Cancelled extends Error {
  constructor() {
    super("query stopped")
    this.name = "Cancelled"
  }
}

/**
 * A problem with the engine itself, rather than an error in a query.  Its
 * message is the app's own text, with any SuperSQL in `backticks`.
 */
export class EngineProblem extends Error {
  /** What Go printed about the problem (e.g., a panic and goroutine stacks). */
  readonly output: string

  constructor(message: string, output: string) {
    super(message)
    this.output = output
  }
}

/**
 * Thrown by run when the engine crashes, most often because it ran out of
 * memory.  The engine is restarted (unless it crashed while starting), so
 * later queries work.
 */
export class EngineCrashed extends EngineProblem {
  readonly outOfMemory: boolean

  constructor(outOfMemory: boolean, output: string, restarted: boolean) {
    const then = restarted ? ", so it was restarted" : " while it was starting"
    super(
      outOfMemory
        ? `The query engine ran out of memory${then}. It runs in your browser, ` +
            "which limits it to 4 GB. Try a query that returns less, such as one that ends in " +
            "`head 100` or aggregates with `count() by ...`, or open less data."
        : `The query engine crashed${then}. This is a bug in SuperDB.`,
      output,
    )
    this.name = "EngineCrashed"
    this.outOfMemory = outOfMemory
  }
}

/**
 * Thrown by run when the query panics.  SuperDB's runtime recovers from a
 * panic in a query operator, and the engine from one in the rest of the
 * query, and returns it as an error, so the engine keeps running.  (A panic
 * in some other goroutine, such as a file reader's, crashes the engine.)
 */
export class EnginePanic extends EngineProblem {
  constructor(output: string) {
    super("The query hit a bug in SuperDB.", output)
    this.name = "EnginePanic"
  }
}

interface Pending {
  resolve: (msg: FromWorker) => void
  reject: (e: Error) => void
}

export class Engine {
  /** Types are shared across queries so shapes compare by identity. */
  readonly context = new TypeContext()
  version = ""

  private opts: EngineOptions
  private worker: Worker | undefined
  private ready: Promise<void> | undefined
  // cancelStart fails a start that's still loading, e.g., when Stop replaces
  // the worker before it's ready.
  private cancelStart: ((err: Error) => void) | undefined
  // The number of runs and exports in progress, including ones waiting for
  // the engine to start or for files to load.
  private active = 0
  private module: WebAssembly.Module | undefined
  private pending = new Map<number, Pending>()
  private nextID = 1
  private loadedFiles: readonly File[] | undefined

  constructor(opts: EngineOptions) {
    this.opts = opts
  }

  /** Starts the engine (fetching and compiling it the first time). */
  start(): Promise<void> {
    if (this.ready) return this.ready
    const worker = new Worker(this.opts.workerURL, { type: "module" })
    this.worker = worker
    this.loadedFiles = undefined
    let started = false
    this.ready = new Promise<void>((resolve, reject) => {
      this.cancelStart = reject
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data
        switch (msg.type) {
          case "progress":
            this.opts.onProgress?.(msg.loaded, msg.total)
            return
          case "ready":
            started = true
            this.version = msg.version
            if (msg.module) this.module = msg.module
            resolve()
            return
          case "load-error":
            this.ready = undefined
            reject(new Error(msg.message))
            return
          case "crashed": {
            if (this.worker !== worker) return
            const err = new EngineCrashed(msg.outOfMemory, msg.output, started)
            this.replaceWorker(err)
            reject(err)
            // Start a new engine right away.  That frees the old one's
            // memory and gets the new one ready for the next query.  (If it
            // crashed while starting, wait for the next query to try again.)
            if (started) this.start().catch(() => {})
            return
          }
          default: {
            const p = this.pending.get(msg.id)
            if (!p) return
            this.pending.delete(msg.id)
            if (msg.type !== "error") p.resolve(msg)
            else if (msg.message.startsWith("panic: ")) p.reject(new EnginePanic(msg.message))
            else p.reject(new Error(msg.message))
          }
        }
      }
      worker.onerror = (ev) => {
        const err = new Error(ev.message || "engine worker failed")
        reject(err)
        this.failPending(err)
      }
    })
    const req: ToWorker = { type: "load", execURL: this.opts.execURL, wasmURL: this.opts.wasmURL, module: this.module }
    worker.postMessage(req)
    return this.ready
  }

  private failPending(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private request(req: ToWorker & { id: number }): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject })
      this.worker!.postMessage(req)
    })
  }

  /** Stops a running query by replacing the worker. */
  stop(): void {
    this.replaceWorker(new Cancelled())
  }

  // replaceWorker ends the worker and fails its requests with err.  The next
  // call to start makes a new worker, reusing the compiled engine.
  private replaceWorker(err: Error) {
    if (!this.worker) return
    this.worker.terminate()
    this.worker = undefined
    this.cancelStart?.(err)
    this.cancelStart = undefined
    this.ready = undefined
    this.failPending(err)
  }

  get busy(): boolean {
    return this.active > 0
  }

  // track counts an operation as active until it's done.
  private async track<T>(op: () => Promise<T>): Promise<T> {
    this.active++
    try {
      return await op()
    } finally {
      this.active--
    }
  }

  // load gives the engine the files to query, unless it already has them.
  private async load(files: readonly File[]) {
    await this.start()
    if (this.loadedFiles !== files) {
      await this.request({ type: "inputs", id: this.nextID++, files: [...files] })
      this.loadedFiles = files
    }
  }

  /** Runs a query over files and decodes the results. */
  run(program: string, files: readonly File[], opts: { format: string; limit: number }): Promise<QueryOutcome> {
    return this.track(() => this.runQuery(program, files, opts))
  }

  private async runQuery(program: string, files: readonly File[], opts: { format: string; limit: number }): Promise<QueryOutcome> {
    await this.load(files)
    const msg = await this.request({
      type: "run",
      id: this.nextID++,
      program,
      format: opts.format,
      limit: opts.limit,
    })
    if (msg.type !== "result") throw new Error(`unexpected engine message ${msg.type}`)
    const start = performance.now()
    const results = new ResultSet(msg.bsup, this.context)
    return { results, elapsedMs: msg.elapsedMs, decodeMs: performance.now() - start }
  }

  /**
   * Runs a query over files with no limit and returns all of its output in
   * outputFormat (e.g., "csv"): a string for a text format, or bytes for a
   * binary one.  fusion keeps fusion values instead of defusing them.
   */
  export(
    program: string,
    files: readonly File[],
    opts: { format: string; outputFormat: string; fusion: boolean },
  ): Promise<string | Uint8Array<ArrayBuffer>> {
    return this.track(async () => {
      await this.load(files)
      const msg = await this.request({
        type: "export",
        id: this.nextID++,
        program,
        format: opts.format,
        outputFormat: opts.outputFormat,
        fusion: opts.fusion,
      })
      if (msg.type !== "exported") throw new Error(`unexpected engine message ${msg.type}`)
      return msg.output
    })
  }
}
