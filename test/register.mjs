// Lets the tests import "@superdb/super-ts" from the super-ts checkout
// (SUPER_TS, default ../super-ts) without building or installing it.
import { register } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const superTS = resolve(process.env.SUPER_TS ?? "../super-ts")
register("./resolve-hook.mjs", import.meta.url, { data: { index: pathToFileURL(resolve(superTS, "src/index.ts")).href } })
