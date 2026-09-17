import { Business } from './business/business.entity.js';
import { Category } from './category/category.entity.js';
import dataSource from './config/data-source.js';
import { Product } from './product/product.entity.js';

const CATEGORY_DEFS = [
  { name: 'Hamburguesas', slug: 'hamburguesas', sortOrder: 1 },
  { name: 'Pizzas', slug: 'pizzas', sortOrder: 2 },
  { name: 'Bebidas', slug: 'bebidas', sortOrder: 3 },
  { name: 'Acompañamientos', slug: 'acompanamientos', sortOrder: 4 },
  { name: 'Postres', slug: 'postres', sortOrder: 5 },
];

const PRODUCT_DEFS = [
  {
    name: 'Clásica Brasa',
    description:
      'Carne 180g a la parrilla, queso cheddar, lechuga, tomate, cebolla morada y salsa de la casa.',
    price: 6900,
    categorySlug: 'hamburguesas',
  },
  {
    name: 'Pizza Napolitana',
    description: 'Salsa de tomate, mozzarella fresca, albahaca y aceite de oliva.',
    price: 8900,
    categorySlug: 'pizzas',
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
        }),
      );
      console.log(`Created product: ${def.name}`);
    }
  }

  await dataSource.destroy();
  console.log('Seed complete.');
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
