// To order the products of a category the admin needs ALL of them, not the 20 of the first page: the list is read page by page (the API gives at
// most 100 per page) until the category is complete. A restaurant can have 500 products in total, so a category is never more than 5 pages.
export const WHOLE_CATEGORY_PAGE_SIZE = 100
export const WHOLE_CATEGORY_MAX_PRODUCTS = 500

export class WholeCategoryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WholeCategoryError'
    this.code = code
  }
}

// fetchPage(page, pageSize) -> { items, total, totalPages }   (GET /products/admin?categoryId=...&page=&limit=)
// isCurrent() -> false when a newer request superseded this one: the reading stops and null is returned (the caller drops it).
// Pages are read one after the other; if the category changed while they were being read (a product created, moved or deleted: the same product
// twice, or a count that does not match the total of the last page) the whole reading is repeated once, then it fails: a list that might be
// incomplete is never shown as if it were the category (the server would refuse a reorder from it anyway, with a 409).
export async function loadWholeCategory(fetchPage, { pageSize = WHOLE_CATEGORY_PAGE_SIZE, maxProducts = WHOLE_CATEGORY_MAX_PRODUCTS, attempts = 2, isCurrent = () => true } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const first = await fetchPage(1, pageSize)
    if (!isCurrent()) return null
    if (first.total > maxProducts) {
      throw new WholeCategoryError('Esta categoría tiene más productos de los que se pueden ordenar desde el panel.', 'TOO_LARGE')
    }
    const items = [...first.items]
    let last = first
    for (let page = 2; page <= first.totalPages; page += 1) {
      last = await fetchPage(page, pageSize)
      if (!isCurrent()) return null
      items.push(...last.items)
    }
    const complete = new Set(items.map((item) => item.id)).size === items.length && items.length === last.total
    if (complete) return items
  }
  throw new WholeCategoryError('La lista cambió mientras se cargaba. Actualiza para volver a intentarlo.', 'CHANGED_WHILE_LOADING')
}

// One reading of the complete category for the order controls. `isCurrent()` says whether this is still the latest request: a response that arrives
// after the admin chose another category (or changed a filter) is dropped WITHOUT touching anything, so it can never turn the controls on for a list
// that is no longer the one on screen. Calls exactly one of the callbacks, or none when it is no longer current.
//   onLoaded(items, categoryId)  the complete list of `categoryId`
//   onFailed(error)              the list could not be read completely: the controls stay off
export async function loadCategoryForOrder({ categoryId, fetchPage, isCurrent, onLoaded, onFailed }) {
  try {
    const items = await loadWholeCategory(fetchPage, { isCurrent })
    if (items === null || !isCurrent()) return
    onLoaded(items, categoryId)
  } catch (error) {
    if (isCurrent()) onFailed(error)
  }
}
