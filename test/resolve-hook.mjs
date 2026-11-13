let index

export function initialize(data) {
  index = data.index
}

export async function resolve(specifier, context, next) {
  if (specifier === "@superdb/super-ts") return { url: index, shortCircuit: true }
  return next(specifier, context)
}
