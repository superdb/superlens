// The app's interface to the query engine, which runs in a worker.
//
// Results come back from the worker as BSUP and are decoded here with
// super-ts into typed values for the views.

import { QueryResult, TypeContext, decodeBSUPStream, type Type, type Value } from "@superdb/super-ts"
import type { FromWorker, ToWorker } from "./protocol.ts"

export interface QueryOutcome {
  values: Value[]
  shapes: Type[]
  warnings: string[]
  /** Time spent running the query in the engine. */
  elapsedMs: number
  /** Time spent decoding the results. */
  decodeMs: number
  /** Size of the BSUP results. */
  bytes: number
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
    this.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data
        switch (msg.type) {
          case "progress":
            this.opts.onProgress?.(msg.loaded, msg.total)
            return
          case "ready":
            this.version = msg.version
            if (msg.module) this.module = msg.module
            resolve()
            return
          case "load-error":
            this.ready = undefined
            reject(new Error(msg.message))
            return
          default: {
            const p = this.pending.get(msg.id)
            if (!p) return
            this.pending.delete(msg.id)
            if (msg.type === "error") p.reject(new Error(msg.message))
            else p.resolve(msg)
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
    if (!this.worker) return
    this.worker.terminate()
    this.worker = undefined
    this.ready = undefined
    this.failPending(new Cancelled())
  }

  get busy(): boolean {
    return this.pending.size > 0
  }

  /** Runs a query over files and decodes the results. */
  async run(program: string, files: readonly File[], opts: { format: string; limit: number }): Promise<QueryOutcome> {
    await this.start()
    if (this.loadedFiles !== files) {
      await this.request({ type: "inputs", id: this.nextID++, files: [...files] })
      this.loadedFiles = files
    }
    const msg = await this.request({
      type: "run",
      id: this.nextID++,
      program,
      format: opts.format,
      limit: opts.limit,
    })
    if (msg.type !== "result") throw new Error(`unexpected engine message ${msg.type}`)
    const start = performance.now()
    const bsup = msg.bsup
    async function* chunks() {
      yield bsup
    }
    const result = new QueryResult(decodeBSUPStream(chunks(), { context: this.context }))
    const values = await result.collect()
    return {
      values,
      shapes: result.shapes,
      warnings: result.warnings,
      elapsedMs: msg.elapsedMs,
      decodeMs: performance.now() - start,
      bytes: bsup.length,
    }
  }
}
