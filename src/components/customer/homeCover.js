// TRANSITIONAL EXCEPTION — remove when restaurants can configure their own cover (future phase).
//
// The welcome screen used to show one fixed photo to every restaurant, and that photo shows the "LA BRASA 47" sign. Until each
// restaurant can upload its own cover, only the restaurant whose slug is EXACTLY `brasa-47` keeps this photo; every other
// restaurant gets a neutral background (see `.home__hero--neutral` in styles/index.css), with no image at all.
//
// To remove the exception once configurable covers exist: delete this file, drop the `cover` lookup in HomeScreen.jsx
// (pass the restaurant's own cover URL instead) and delete /public/images/restaurant-hero.webp.
export const TRANSITIONAL_COVER_SLUG = 'brasa-47'
export const TRANSITIONAL_COVER_SRC = '/images/restaurant-hero.webp'

// The cover image URL for a restaurant, or null (neutral background). Exact, case-sensitive match: no prefixes, no trimming.
export function homeCoverFor(businessSlug) {
  return businessSlug === TRANSITIONAL_COVER_SLUG ? TRANSITIONAL_COVER_SRC : null
}
