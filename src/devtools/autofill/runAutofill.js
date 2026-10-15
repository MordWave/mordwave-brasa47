import { generateBusiness, generateCategory, generateProduct, generateTable } from './generators.js'
import { PLANS } from './plans.js'
import { createRng } from './random.js'

const GENERATE = {
  product: (rng, context) => generateProduct(rng, { categories: context.categories }),
  category: (rng, context) => generateCategory(rng, { exclude: context.existingNames }),
  table: (rng, context) => generateTable(rng, { exclude: context.existingNames }),
  business: (rng) => generateBusiness(rng),
}

export const AUTOFILL_KINDS = Object.keys(GENERATE)

// Pure entry point used by the button: current form values in, patch out. It does not touch the form, the network,
// storage or auth; applying the patch (setting field state) is the form's own job, and saving stays manual.
//   kind     'product' | 'category' | 'table' | 'business'
//   values   current form values (see the plans for the keys)
//   context  { isEditing, categories (REAL ones, product only), existingNames (to avoid duplicates) }
//   random   () => [0,1): Math.random in the app, a seeded source in tests
export function runAutofill({ kind, values, context = {}, random = Math.random }) {
  if (!GENERATE[kind]) throw new Error(`Unknown autofill kind: ${kind}`)
  const generated = GENERATE[kind](createRng(random), context)
  return PLANS[kind](values, generated, context)
}
