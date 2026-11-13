// The app imports super-ts by its package name.  This points those imports
// in dist/app at the compiled copy in dist/vendor/super-ts so the browser can
// load them without an import map (which the page's content security policy
// would block as an inline script).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist")
const vendorIndex = join(dist, "vendor/super-ts/index.js")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

for (const file of walk(join(dist, "app"))) {
  if (!file.endsWith(".js")) continue
  const src = readFileSync(file, "utf8")
  if (!src.includes('"@superdb/super-ts"')) continue
  let rel = relative(dirname(file), vendorIndex).split("\\").join("/")
  if (!rel.startsWith(".")) rel = "./" + rel
  writeFileSync(file, src.replaceAll('"@superdb/super-ts"', JSON.stringify(rel)))
}
