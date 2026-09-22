import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Category } from '../category/category.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { ProductImageService } from './product-image.service.js';
import { Product } from './product.entity.js';
import { ProductService } from './product.service.js';

function createRepoMock() {
  return {
    create: vi.fn((entity: unknown) => entity),
    save: vi.fn(async (entity: unknown) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
    softDelete: vi.fn(),
  };
}

function createProductImageServiceMock() {
  return {
    upload: vi.fn(),
    remove: vi.fn(),
  };
}

function createPublicBusinessResolverMock() {
  return { resolve: vi.fn() };
}

describe('ProductService', () => {
  let service: ProductService;
  let productRepo: ReturnType<typeof createRepoMock>;
  let categoryRepo: ReturnType<typeof createRepoMock>;
  let businessRepo: ReturnType<typeof createRepoMock>;
  let productImageService: ReturnType<typeof createProductImageServiceMock>;
  let publicBusinessResolver: ReturnType<typeof createPublicBusinessResolverMock>;

  const admin: SafeUser = {
    id: 'admin-1',
    email: 'admin@brasa47.cl',
    role: UserRole.ADMIN,
    businessId: 'biz-1',
    active: true,
  };

  const superAdmin: SafeUser = {
    id: 'super-1',
    email: 'super@mordwave.cl',
    role: UserRole.SUPER_ADMIN,
    businessId: null,
    active: true,
  };

  beforeEach(async () => {
    productRepo = createRepoMock();
    categoryRepo = createRepoMock();
    businessRepo = createRepoMock();
    productImageService = createProductImageServiceMock();
    publicBusinessResolver = createPublicBusinessResolverMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductService,
        { provide: getRepositoryToken(Product), useValue: productRepo },
        { provide: getRepositoryToken(Category), useValue: categoryRepo },
        { provide: getRepositoryToken(Business), useValue: businessRepo },
        { provide: ProductImageService, useValue: productImageService },
        { provide: PublicBusinessResolverService, useValue: publicBusinessResolver },
      ],
    }).compile();

    service = moduleRef.get(ProductService);
  });

  it('ADMIN create ignores a foreign businessId from the body and uses their own', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

    await service.create(
      { name: 'Producto', price: 1000, businessId: 'other-biz', categoryId: 'cat-1' },
      admin,
    );

    expect(productRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1' }),
    );
  });

  it('rejects create for an ADMIN with no businessId', async () => {
    const adminNoBusiness: SafeUser = { ...admin, businessId: null };

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        adminNoBusiness,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects create when the category belongs to a different business', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'other-biz', active: true });

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects create when the category is inactive', async () => {
    businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: false });

    await expect(
      service.create(
        { name: 'Producto', price: 1000, businessId: 'biz-1', categoryId: 'cat-1' },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ADMIN cannot update a product belonging to another business', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz', categoryId: 'cat-1' });

    await expect(service.update('p1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ADMIN update rejects a category from a different business', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-2', businessId: 'other-biz', active: true });

    await expect(
      service.update('p1', { categoryId: 'cat-2' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects moving a product to an inactive category', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: true,
    });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-2', businessId: 'biz-1', active: false });

    await expect(
      service.update('p1', { categoryId: 'cat-2' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects reactivating (active:false -> true) a product whose category is inactive', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: false,
    });
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: false });

    await expect(
      service.update('p1', { active: true }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows deactivating a product regardless of its category status', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: true,
    });

    await service.update('p1', { active: false }, admin);

    // The category check is never even reached for a plain deactivation.
    expect(categoryRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });

  it('does not re-check the category on an unrelated edit to an already-active product', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'p1',
      businessId: 'biz-1',
      categoryId: 'cat-1',
      active: true,
    });

    await service.update('p1', { name: 'renamed' }, admin);

    expect(categoryRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }));
  });

  it('SUPER_ADMIN moving a product to another business must also move its category', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });
    businessRepo.findOne.mockResolvedValue({ id: 'biz-2' });
    // The existing category still belongs to the OLD business.
    categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

    await expect(
      service.update('p1', { businessId: 'biz-2' }, superAdmin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SUPER_ADMIN update keeps the current business when none is sent', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', categoryId: 'cat-1' });

    await service.update('p1', { name: 'renamed' }, superAdmin);

    expect(businessRepo.findOne).not.toHaveBeenCalled();
    expect(productRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1', name: 'renamed' }),
    );
  });

  it('findAllPublic resolves the business first, then only includes products whose category is active', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    categoryRepo.find.mockResolvedValue([{ id: 'cat-1' }, { id: 'cat-2' }]);
    productRepo.find.mockResolvedValue([]);

    await service.findAllPublic({ businessSlug: 'brasa-47' });

    expect(publicBusinessResolver.resolve).toHaveBeenCalledWith({ businessSlug: 'brasa-47' });
    expect(categoryRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true, businessId: 'biz-1' }) }),
    );
    const callArgs = productRepo.find.mock.calls[0][0];
    expect(callArgs.where.active).toBe(true);
    expect(callArgs.where.businessId).toBe('biz-1');
    expect(callArgs.where.categoryId).toEqual(expect.objectContaining({ _type: 'in' }));
  });

  it('findAllPublic skips the product query entirely when no category is active', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    categoryRepo.find.mockResolvedValue([]);

    const result = await service.findAllPublic({ businessId: 'biz-1' });

    expect(result).toEqual([]);
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('findAllPublic never queries the database when the business cannot be resolved', async () => {
    publicBusinessResolver.resolve.mockRejectedValue(new BadRequestException());

    await expect(service.findAllPublic({})).rejects.toBeInstanceOf(BadRequestException);
    expect(categoryRepo.find).not.toHaveBeenCalled();
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('findOnePublic 404s on an inactive product (same as not existing)', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    productRepo.findOne.mockResolvedValue(null);

    await expect(
      service.findOnePublic('p1', { businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(productRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p1', active: true, businessId: 'biz-1' }),
      }),
    );
  });

  it('findOnePublic 404s when the product is active but its category is not', async () => {
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    productRepo.findOne.mockResolvedValue({ id: 'p1', categoryId: 'cat-1', active: true });
    categoryRepo.findOne.mockResolvedValue(null);

    await expect(
      service.findOnePublic('p1', { businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(categoryRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cat-1', active: true }) }),
    );
  });

  it('findOnePublic 404s a product that belongs to a different business (tenant-scoped lookup)', async () => {
    // The businessId filter is baked into the findOne() call itself — a
    // product from another business simply doesn't match, same as an
    // unknown id.
    publicBusinessResolver.resolve.mockResolvedValue('biz-1');
    productRepo.findOne.mockResolvedValue(null);

    await expect(
      service.findOnePublic('p-from-other-biz', { businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(productRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
    );
  });

  it('findAllAdmin: ADMIN ignores a foreign businessId from the query and sees only their own', async () => {
    productRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({ businessId: 'other-biz' }, admin);

    expect(productRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-1' }) }),
    );
    // No active filter — admin listing must include inactive products.
    const callArgs = productRepo.find.mock.calls[0][0];
    expect(callArgs.where).not.toHaveProperty('active');
  });

  it('findAllAdmin: SUPER_ADMIN with no businessId gets an unfiltered (all-business) query', async () => {
    productRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({}, superAdmin);

    const callArgs = productRepo.find.mock.calls[0][0];
    expect(callArgs.where).not.toHaveProperty('businessId');
  });

  it('findAllAdmin: SUPER_ADMIN can scope to a specific business', async () => {
    productRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({ businessId: 'biz-2' }, superAdmin);

    expect(productRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ businessId: 'biz-2' }) }),
    );
  });

  describe('persists tag/ingredients/removableIngredients/addOns', () => {
    it('create() persists all four fields exactly as given', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      await service.create(
        {
          name: 'Clásica Brasa',
          price: 6900,
          businessId: 'biz-1',
          categoryId: 'cat-1',
          tag: 'Más pedido',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
          addOns: [{ name: 'Queso extra', price: 1200 }],
        },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'Más pedido',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
          addOns: [{ name: 'Queso extra', price: 1200 }],
        }),
      );
    });

    it('update() persists a change to tag and addOns onto an existing product', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        tag: null,
        ingredients: [],
        removableIngredients: [],
        addOns: [],
      });

      await service.update(
        'p1',
        { tag: 'Nuevo', addOns: [{ name: 'Tocino', price: 1500 }] },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'Nuevo',
          addOns: [{ name: 'Tocino', price: 1500 }],
        }),
      );
    });

    it('update() persists a change to ingredients and removableIngredients together', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        tag: null,
        ingredients: ['Carne', 'Pan'],
        removableIngredients: [],
        addOns: [],
      });

      await service.update(
        'p1',
        { ingredients: ['Carne', 'Pan', 'Queso'], removableIngredients: ['Queso'] },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
        }),
      );
    });
  });

  describe('removableIngredients must be a subset of ingredients', () => {
    it('create() accepts a valid subset', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      await service.create(
        {
          name: 'Clásica Brasa',
          price: 6900,
          businessId: 'biz-1',
          categoryId: 'cat-1',
          ingredients: ['Carne', 'Pan', 'Queso'],
          removableIngredients: ['Queso'],
        },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalled();
    });

    it('create() rejects a removableIngredients entry not present in ingredients', async () => {
      businessRepo.findOne.mockResolvedValue({ id: 'biz-1' });
      categoryRepo.findOne.mockResolvedValue({ id: 'cat-1', businessId: 'biz-1', active: true });

      const error = await service
        .create(
          {
            name: 'Clásica Brasa',
            price: 6900,
            businessId: 'biz-1',
            categoryId: 'cat-1',
            ingredients: ['Carne', 'Pan'],
            removableIngredients: ['Queso'], // not in ingredients
          },
          admin,
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() rejects a PATCH that only changes removableIngredients, validated against the EXISTING ingredients', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan'],
        removableIngredients: [],
      });

      const error = await service
        .update('p1', { removableIngredients: ['Queso'] }, admin) // "Queso" isn't in the existing ingredients
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() rejects a PATCH that only changes ingredients, orphaning an entry the EXISTING removableIngredients still references', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan', 'Queso'],
        removableIngredients: ['Queso'],
      });

      // Renaming/dropping "Queso" from ingredients without also updating
      // removableIngredients must be rejected, not silently leave a
      // removableIngredients entry that no longer matches anything.
      const error = await service
        .update('p1', { ingredients: ['Carne', 'Pan'] }, admin)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ errorCode: 'REMOVABLE_INGREDIENTS_NOT_SUBSET' }),
      );
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('update() accepts changing both fields together consistently', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan', 'Queso'],
        removableIngredients: ['Queso'],
      });

      await service.update(
        'p1',
        { ingredients: ['Carne', 'Pan'], removableIngredients: [] },
        admin,
      );

      expect(productRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ ingredients: ['Carne', 'Pan'], removableIngredients: [] }),
      );
    });

    it('update() leaves an already-consistent product alone on an unrelated edit', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        categoryId: 'cat-1',
        active: true,
        ingredients: ['Carne', 'Pan', 'Queso'],
        removableIngredients: ['Queso'],
      });

      await service.update('p1', { name: 'renamed' }, admin);

      expect(productRepo.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }));
    });
  });

  // Soft delete: TypeORM's @DeleteDateColumn makes every find/findOne/count
  // on this repository exclude a soft-deleted row automatically (verified
  // against the installed TypeORM's own source — see product.entity.ts).
  // These tests simulate that by having findOne resolve null for an id
  // that's already been soft-deleted, since that's exactly what TypeORM
  // would return once deletedAt is set — the service code has no idea
  // (and shouldn't need to) whether "not found" means "never existed" or
  // "was deleted".
  describe('remove', () => {
    it('soft-deletes via repository.softDelete(), never a real delete', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1' });

      await service.remove('p1', admin);

      expect(productRepo.softDelete).toHaveBeenCalledWith('p1');
    });

    it('rejects removing a product belonging to another business', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz' });

      await expect(service.remove('p1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(productRepo.softDelete).not.toHaveBeenCalled();
    });

    it('a second delete attempt 404s instead of deleting again', async () => {
      productRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('p1', admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(productRepo.softDelete).not.toHaveBeenCalled();
    });
  });

  it('a soft-deleted product cannot be edited afterward (404, same as never existing)', async () => {
    productRepo.findOne.mockResolvedValue(null);

    await expect(service.update('p1', { name: 'renamed' }, admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('admin listing never opts back into seeing soft-deleted rows (no withDeleted)', async () => {
    productRepo.find.mockResolvedValue([]);

    await service.findAllAdmin({}, admin);

    const callArgs = productRepo.find.mock.calls.at(-1)[0];
    expect(callArgs).not.toHaveProperty('withDeleted');
  });

  describe('attachImage', () => {
    const file = { buffer: Buffer.from('bytes'), size: 100 };

    it('rejects attaching an image to a product belonging to another business', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz' });

      await expect(service.attachImage('p1', admin, file)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(productImageService.upload).not.toHaveBeenCalled();
    });

    it('updates imageUrl only after the upload succeeds', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1', imageUrl: null });
      productImageService.upload.mockResolvedValue('https://cdn.example/biz-1/p1/imagen.webp?v=1');

      const result = await service.attachImage('p1', admin, file);

      expect(productImageService.upload).toHaveBeenCalledWith('biz-1', 'p1', file);
      expect(productRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrl: 'https://cdn.example/biz-1/p1/imagen.webp?v=1' }),
      );
      expect(result.imageUrl).toBe('https://cdn.example/biz-1/p1/imagen.webp?v=1');
    });

    it('leaves imageUrl untouched when the upload fails', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        imageUrl: 'https://cdn.example/old.webp',
      });
      productImageService.upload.mockRejectedValue(new Error('storage down'));

      await expect(service.attachImage('p1', admin, file)).rejects.toThrow('storage down');

      expect(productRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('removeImage', () => {
    it('rejects removing the image of a product belonging to another business', async () => {
      productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'other-biz' });

      await expect(service.removeImage('p1', admin)).rejects.toBeInstanceOf(ForbiddenException);
      expect(productImageService.remove).not.toHaveBeenCalled();
    });

    it('clears imageUrl to null after a successful Storage removal', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 'p1',
        businessId: 'biz-1',
        imageUrl: 'https://cdn.example/biz-1/p1/imagen.webp?v=1',
      });

      const result = await service.removeImage('p1', admin);

      expect(productImageService.remove).toHaveBeenCalledWith('biz-1', 'p1');
      expect(productRepo.save).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: null }));
      expect(result.imageUrl).toBeNull();
    });
  });

  it('soft-deleting a product never touches its Storage image (kept for history)', async () => {
    productRepo.findOne.mockResolvedValue({ id: 'p1', businessId: 'biz-1' });

    await service.remove('p1', admin);

    expect(productImageService.remove).not.toHaveBeenCalled();
    expect(productRepo.softDelete).toHaveBeenCalledWith('p1');
  });
});
