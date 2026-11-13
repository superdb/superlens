// Development: builds the app (and the wasm engine if it's missing), then
// recompiles on changes and serves dist/ at http://localhost:8080/.
// Reload the page to pick up changes.

import { execFileSync, spawn } from "node:child_process"
import { cpSync, existsSync, watch } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const build = join(root, "scripts/build.mjs")

const appOnly = existsSync(join(root, "dist/super.wasm"))
execFileSync(process.execPath, appOnly ? [build, "--app"] : [build], { cwd: root, stdio: "inherit" })

// Recompile the app on changes.  (Changes to super-ts need a rebuild.)
let tsc
try {
  tsc = [process.execPath, [createRequire(join(root, "package.json")).resolve("typescript/bin/tsc")]]
} catch {
  tsc = ["tsc", []]
}
spawn(tsc[0], [...tsc[1], "-p", join(root, "tsconfig.json"), "--watch", "--preserveWatchOutput"], {
  cwd: root,
  stdio: "inherit",
})

// After each compile, point the app's super-ts imports at the compiled copy.
const rewrite = () => {
  try {
    execFileSync(process.execPath, [join(root, "scripts/rewrite-imports.mjs")], { cwd: root, stdio: "inherit" })
  } catch {
    // Reported by the script.
  }
}
let timer
watch(join(root, "dist/app"), { recursive: true }, () => {
  clearTimeout(timer)
  timer = setTimeout(rewrite, 150)
})

watch(join(root, "public"), { recursive: true }, () => {
  cpSync(join(root, "public"), join(root, "dist"), { recursive: true })
})

spawn(process.execPath, [join(root, "scripts/serve.mjs"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit" })
