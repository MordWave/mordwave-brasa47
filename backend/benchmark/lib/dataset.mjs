// Deterministic benchmark dataset (pure: no DB, no network), so the same
// --seed always yields the same menu shape and tests can assert on it.
// Everything is clearly labelled "[BENCH]" and uses a "bench-" slug prefix.
import { randomBytes } from 'node:crypto';
import { BENCH_EMAIL_DOMAIN, BENCH_PREFIX } from './guards.mjs';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same generator the backend uses (src/table/token.util.ts: randomBytes(24) base64url).
export const opaqueToken = () => randomBytes(24).toString('base64url');

const CATEGORY_NAMES = ['Hamburguesas', 'Pizzas', 'Bebidas', 'Acompañamientos', 'Postres'];
const INGREDIENTS = ['Pan brioche', 'Carne 150 g', 'Queso cheddar', 'Lechuga', 'Tomate', 'Cebolla', 'Pepinillos', 'Salsa de la casa', 'Masa madre', 'Mozzarella'];
const ADD_ONS = [
  ['Queso extra', 1200],
  ['Tocino', 1500],
  ['Huevo frito', 1000],
  ['Doble carne', 2500],
  ['Palta', 1300],
];
const TAGS = [null, null, null, 'Popular', 'Nuevo', 'Chef'];

export const pad = (n, width = 2) => String(n).padStart(width, '0');
export const businessSlug = (index) => `${BENCH_PREFIX}-${pad(index)}`;
export const adminEmail = (index) => `bench-admin-${pad(index)}@${BENCH_EMAIL_DOMAIN}`;

// index is 1-based. `products` is the total per business, spread evenly over
// the categories (50 over 5 => 10 each).
export function buildBusiness(index, { categories = 5, products = 50, tables = 10, seed = 1 } = {}) {
  const rng = mulberry32(seed * 1000 + index);
  const cats = Array.from({ length: categories }, (_, c) => ({
    name: `[BENCH] ${CATEGORY_NAMES[c % CATEGORY_NAMES.length]}${c >= CATEGORY_NAMES.length ? ` ${c + 1}` : ''}`,
    slug: `cat-${pad(c + 1)}`,
    sortOrder: c + 1,
  }));
  const prods = Array.from({ length: products }, (_, p) => {
    const category = cats[p % categories];
    const addOnCount = Math.floor(rng() * 4);
    const removable = INGREDIENTS.slice(0, 3 + Math.floor(rng() * 3)).slice(0, 2 + Math.floor(rng() * 3));
    return {
      name: `[BENCH] Producto ${pad(index)}-${pad(p + 1)}`,
      description: `Producto de prueba de carga ${pad(index)}-${pad(p + 1)}. Texto de relleno con un largo comparable a una descripción real de menú para medir el tamaño de la respuesta.`,
      price: 2500 + Math.floor(rng() * 90) * 100,
      categorySlug: category.slug,
      sortOrder: p + 1,
      tag: TAGS[Math.floor(rng() * TAGS.length)],
      ingredients: INGREDIENTS.slice(0, 4 + Math.floor(rng() * 4)),
      removableIngredients: removable,
      addOns: ADD_ONS.slice(0, addOnCount).map(([name, price]) => ({ name, price })),
    };
  });
  const tbls = Array.from({ length: tables }, (_, t) => ({ name: `Mesa ${t + 1}`, qrToken: opaqueToken(), sessionToken: opaqueToken() }));
  return {
    index,
    name: `[BENCH] Restaurante ${pad(index)}`,
    slug: businessSlug(index),
    adminEmail: adminEmail(index),
    categories: cats,
    products: prods,
    tables: tbls,
  };
}
