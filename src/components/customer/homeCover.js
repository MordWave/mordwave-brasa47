import { isValidMediaUrl } from '../../utils/mediaUrl.js'

// Which image (if any) the welcome screen shows, in this priority:
//   1. the restaurant's OWN cover (`coverUrl`, configured by its administrators) when it is a valid image URL;
//   2. else, ONLY for the slug exactly `brasa-47`, the historical photo below (a TRANSITIONAL EXCEPTION);
//   3. else no image: the neutral CSS background (`.home__hero--neutral`), with no picture of any restaurant.
// If the image that was chosen FAILS to load, the screen falls back to the neutral background and never to another picture:
// a failed custom cover does not bring back the historical photo, and a restaurant never shows another restaurant's image.
//
// TRANSITIONAL EXCEPTION — remove once Brasa 47 has its own cover configured (the future "Brasa 47 transition" step):
// delete TRANSITIONAL_COVER_* and `homeCoverFor` below, drop priority 2 from `resolveHomeCover`, and delete
// /public/images/restaurant-hero.webp. Until then, only the restaurant whose slug is EXACTLY `brasa-47` can show it.
export const TRANSITIONAL_COVER_SLUG = 'brasa-47'
export const TRANSITIONAL_COVER_SRC = '/images/restaurant-hero.webp'

// The historical photo for a restaurant, or null. Exact, case-sensitive match: no prefixes, no trimming.
export function homeCoverFor(businessSlug) {
  return businessSlug === TRANSITIONAL_COVER_SLUG ? TRANSITIONAL_COVER_SRC : null
}

const NEUTRAL = { src: null, kind: 'neutral' }

// A local DRAFT cover (admin preview only): the blob: URL of a picture the administrator cropped in this browser and has NOT
// uploaded. The customer app never passes one; only a blob: URL qualifies (never a remote or script URL).
export const isDraftCoverSrc = (value) => typeof value === 'string' && value.startsWith('blob:') && value.length <= 2048

// { src, kind } with kind 'draft' | 'custom' | 'transitional' | 'neutral'. `failedSrc` is the URL that already failed to load (if any).
export function resolveHomeCover({ coverUrl, businessSlug, failedSrc = null, draftSrc = null } = {}) {
  if (isDraftCoverSrc(draftSrc)) return draftSrc === failedSrc ? NEUTRAL : { src: draftSrc, kind: 'draft' }
  if (isValidMediaUrl(coverUrl)) return coverUrl === failedSrc ? NEUTRAL : { src: coverUrl, kind: 'custom' }
  const historical = homeCoverFor(businessSlug)
  if (historical) return historical === failedSrc ? NEUTRAL : { src: historical, kind: 'transitional' }
  return NEUTRAL
}
