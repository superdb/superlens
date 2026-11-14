// Messages between the app and the engine worker.

export interface LoadRequest {
  type: "load"
  /** URL of Go's wasm_exec.js. */
  execURL: string
  /** URL of super.wasm (used when module isn't given). */
  wasmURL: string
  /** A module compiled by an earlier worker, to skip fetching and compiling. */
  module?: WebAssembly.Module
}

export interface InputsRequest {
  type: "inputs"
  id: number
  files: File[]
}

export interface RunRequest {
  type: "run"
  id: number
  program: string
  format: string
  limit: number
}

export type ToWorker = LoadRequest | InputsRequest | RunRequest

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; version: string; module?: WebAssembly.Module }
  | { type: "load-error"; message: string }
  | { type: "inputs-done"; id: number }
  | { type: "result"; id: number; bsup: Uint8Array; elapsedMs: number }
  | { type: "error"; id: number; message: string }
  // The Go program exited, so the worker can't run anything else.  output
  // is what Go printed about why (e.g., "fatal error: out of memory" or
  // "panic: ...", followed by goroutine stacks).
  | { type: "crashed"; outOfMemory: boolean; output: string }
