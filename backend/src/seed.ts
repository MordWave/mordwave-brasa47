import bcrypt from 'bcrypt';
import { Business } from './business/business.entity.js';
import { Category } from './category/category.entity.js';
import dataSource from './config/data-source.js';
import { Product } from './product/product.entity.js';
import { User } from './user/user.entity.js';
import { UserRole } from './user/user-role.enum.js';

const BCRYPT_COST = 12;

const CATEGORY_DEFS = [
  { name: 'Hamburguesas', slug: 'hamburguesas', sortOrder: 1 },
  { name: 'Pizzas', slug: 'pizzas', sortOrder: 2 },
  { name: 'Bebidas', slug: 'bebidas', sortOrder: 3 },
  { name: 'Acompañamientos', slug: 'acompanamientos', sortOrder: 4 },
  { name: 'Postres', slug: 'postres', sortOrder: 5 },
];

// tag/ingredients/removableIngredients/addOns for these two mirror the
// values the old demo dataset (src/data/menu.js, removed in Fase 7 Bloque
// 4) hardcoded for the two real products it happened to name-match —
// preserved here so a fresh database is born with the same real
// personalization instead of empty fields. Limonada Natural had none in
// that dataset either, so it stays without personalization on purpose.
const PRODUCT_DEFS = [
  {
    name: 'Clásica Brasa',
    description:
      'Carne 180g a la parrilla, queso cheddar, lechuga, tomate, cebolla morada y salsa de la casa.',
    price: 6900,
    categorySlug: 'hamburguesas',
    tag: 'Más pedido',
    ingredients: [
      'Carne 180 g',
      'Pan brioche',
      'Queso cheddar',
      'Lechuga',
      'Tomate',
      'Cebolla morada',
      'Salsa de la casa',
    ],
    removableIngredients: ['Queso cheddar', 'Lechuga', 'Tomate', 'Cebolla morada', 'Salsa de la casa'],
    addOns: [
      { name: 'Queso extra', price: 1200 },
      { name: 'Tocino', price: 1500 },
      { name: 'Huevo frito', price: 1000 },
      { name: 'Doble carne', price: 2500 },
    ],
  },
  {
    name: 'Pizza Napolitana',
    description: 'Salsa de tomate, mozzarella fresca, albahaca y aceite de oliva.',
    price: 8900,
    categorySlug: 'pizzas',
    ingredients: ['Base de masa artesanal', 'Salsa de tomate', 'Mozzarella fresca', 'Albahaca', 'Aceite de oliva'],
    removableIngredients: ['Albahaca'],
    addOns: [
      { name: 'Extra mozzarella', price: 1800 },
      { name: 'Pepperoni', price: 2000 },
      { name: 'Aceitunas', price: 1000 },
      { name: 'Orégano fresco', price: 500 },
    ],
  },
  {
    name: 'Limonada Natural',
    description: 'Limonada natural recién exprimida, con hielo y rodajas de limón.',
    price: 3200,
    categorySlug: 'bebidas',
  },
];

async function seed() {
  await dataSource.initialize();

  const businessRepo = dataSource.getRepository(Business);
  const categoryRepo = dataSource.getRepository(Category);
  const productRepo = dataSource.getRepository(Product);

  let business = await businessRepo.findOne({ where: { slug: 'brasa-47' } });
  if (!business) {
    business = await businessRepo.save(
      businessRepo.create({ name: 'Brasa 47', slug: 'brasa-47' }),
    );
    console.log('Created business: Brasa 47');
  }

  const categoriesBySlug: Record<string, Category> = {};
  for (const def of CATEGORY_DEFS) {
    let category = await categoryRepo.findOne({
      where: { slug: def.slug, businessId: business.id },
    });
    if (!category) {
      category = await categoryRepo.save(
        categoryRepo.create({ ...def, businessId: business.id }),
      );
      console.log(`Created category: ${def.name}`);
    }
    categoriesBySlug[def.slug] = category;
  }

  for (const def of PRODUCT_DEFS) {
    const exists = await productRepo.findOne({
      where: { name: def.name, businessId: business.id },
    });
    if (!exists) {
      await productRepo.save(
        productRepo.create({
          name: def.name,
          description: def.description,
          price: def.price,
          businessId: business.id,
          categoryId: categoriesBySlug[def.categorySlug].id,
          tag: def.tag,
          ingredients: def.ingredients ?? [],
          removableIngredients: def.removableIngredients ?? [],
          addOns: def.addOns ?? [],
        }),
      );
      console.log(`Created product: ${def.name}`);
    }
  }

  await seedAdminUser(business);

  await dataSource.destroy();
  console.log('Seed complete.');
}

// Requires SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD — no default/predictable
// credentials are ever created. If either is missing, the admin user is
// simply skipped (never printing the email, password, or hash).
async function seedAdminUser(business: Business): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn(
      'SEED_ADMIN_EMAIL and/or SEED_ADMIN_PASSWORD are not set — skipping dev admin user creation.',
    );
    return;
  }

  const userRepo = dataSource.getRepository(User);
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await userRepo.findOne({ where: { email: normalizedEmail } });
  if (existing) {
    console.log('Dev admin user already exists, skipping.');
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await userRepo.save(
    userRepo.create({
      email: normalizedEmail,
      passwordHash,
      role: UserRole.ADMIN,
      businessId: business.id,
    }),
  );
  console.log('Created dev admin user.');
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
