import { apiFetch } from './api'
import { isValidBusinessSlug } from '../utils/businessSlug.js'

// Public menu reads for ONE restaurant, identified by the businessSlug of the table session (resolved from the QR).
// There is no default restaurant: without a valid slug nothing is requested, so the menu of another restaurant can never be
// fetched by accident. Callers show a safe state for MissingBusinessSlugError (see MenuView).
export class MissingBusinessSlugError extends Error {
  constructor() {
    super('A valid businessSlug is required to read a menu')
    this.name = 'MissingBusinessSlugError'
    this.code = 'BUSINESS_SLUG_MISSING'
  }
}

function slugParam(businessSlug) {
  if (!isValidBusinessSlug(businessSlug)) throw new MissingBusinessSlugError()
  return encodeURIComponent(businessSlug)
}

export async function fetchPublicCategories(businessSlug) {
  return apiFetch(`/categories?businessSlug=${slugParam(businessSlug)}`)
}

export async function fetchPublicProducts(businessSlug) {
  return apiFetch(`/products?businessSlug=${slugParam(businessSlug)}`)
}
