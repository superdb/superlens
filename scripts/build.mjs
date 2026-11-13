// Builds SuperLens into dist/:
//
//   dist/super.wasm, dist/wasm_exec.js   the query engine (scripts/build-wasm.sh)
//   dist/vendor/super-ts/                super-ts, compiled from SUPER_TS
//   dist/app/                            the app, compiled from src/
//   dist/index.html, style.css, ...      copied from public/
//
// Usage:
//   node scripts/build.mjs           build everything
//   node scripts/build.mjs --app     skip the wasm build (reuses dist/super.wasm)
//
// Environment:
//   SUPER_REPO   path to the super repo (default: ../super)
//   SUPER_TS     path to the super-ts repo (default: ../super-ts)
//
// The output is a static site with no bundler: browsers load the compiled
// ES modules directly.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "dist")
const superTS = resolve(root, process.env.SUPER_TS ?? "../super-ts")
const appOnly = process.argv.includes("--app")

function tscPath() {
  try {
    return createRequire(join(root, "package.json")).resolve("typescript/bin/tsc")
  } catch {
    return null
  }
}

function tsc(args) {
  const local = tscPath()
  const [cmd, argv] = local ? [process.execPath, [local, ...args]] : ["tsc", args]
  try {
    execFileSync(cmd, argv, { cwd: root, stdio: "inherit" })
  } catch {
    console.error(`build: tsc ${args.join(" ")} failed`)
    process.exit(1)
  }
}

if (!existsSync(join(superTS, "src/index.ts"))) {
  console.error(`build: no super-ts at ${superTS} (set SUPER_TS)`)
  process.exit(1)
}

mkdirSync(dist, { recursive: true })
if (!appOnly) {
  execFileSync("sh", [join(root, "scripts/build-wasm.sh")], { cwd: root, stdio: "inherit" })
} else if (!existsSync(join(dist, "super.wasm"))) {
  console.warn("build: dist/super.wasm is missing; run `npm run build:wasm` to build the query engine")
}

rmSync(join(dist, "app"), { recursive: true, force: true })
rmSync(join(dist, "vendor"), { recursive: true, force: true })

console.log(`compiling super-ts from ${superTS}`)
tsc(["-p", join(superTS, "tsconfig.build.json"), "--outDir", join(dist, "vendor/super-ts"), "--sourceMap", "false"])

console.log("compiling the app")
tsc(["-p", join(root, "tsconfig.json")])

execFileSync(process.execPath, [join(root, "scripts/rewrite-imports.mjs")], { cwd: root, stdio: "inherit" })
cpSync(join(root, "public"), dist, { recursive: true })
console.log(`built ${relative(process.cwd(), dist) || "."}`)
