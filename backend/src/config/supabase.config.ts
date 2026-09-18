import { registerAs } from '@nestjs/config';

export default registerAs('supabase', () => {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new Error('SUPABASE_URL environment variable is required');
  }
  if (!secretKey) {
    throw new Error('SUPABASE_SECRET_KEY environment variable is required');
  }

  return {
    url,
    secretKey,
    bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'product-images',
  };
});
