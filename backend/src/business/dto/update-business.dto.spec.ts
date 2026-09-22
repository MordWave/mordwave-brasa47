import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { UpdateBusinessDto } from './update-business.dto.js';

// PATCH /businesses/me requires a JWT and this project's e2e suite
// deliberately never authenticates (no fixtures) — same reasoning as
// product-add-on.dto.spec.ts, this is the only layer that can reach these
// constraints directly.
describe('UpdateBusinessDto — color validation', () => {
  it('accepts valid #RRGGBB colors (lowercase and uppercase hex)', async () => {
    const dto = plainToInstance(UpdateBusinessDto, {
      primaryColor: '#d94a2b',
      accentColor: '#E9B44C',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects a color missing the leading #', async () => {
    const dto = plainToInstance(UpdateBusinessDto, { primaryColor: 'D94A2B' });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'primaryColor')).toBe(true);
  });

  it('rejects a 3-digit shorthand hex color', async () => {
    const dto = plainToInstance(UpdateBusinessDto, { primaryColor: '#D94' });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'primaryColor')).toBe(true);
  });

  it('rejects a color with non-hex characters', async () => {
    const dto = plainToInstance(UpdateBusinessDto, { accentColor: '#GGGGGG' });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'accentColor')).toBe(true);
  });

  it('rejects a named color (not a hex code)', async () => {
    const dto = plainToInstance(UpdateBusinessDto, { accentColor: 'red' });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'accentColor')).toBe(true);
  });

  it('leaves colors optional — omitting both is valid', async () => {
    const dto = plainToInstance(UpdateBusinessDto, { name: 'Brasa 47' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
