import { SetMetadata } from '@nestjs/common';

export const REQUEST_TIMEOUT_PROFILE_KEY = 'http:requestTimeoutProfile';
export type RequestTimeoutProfile = 'upload';

// Marks a route as an image/file upload: it gets the longer upload deadline
// instead of the default one (see RequestTimeoutInterceptor).
export const UploadTimeout = () => SetMetadata(REQUEST_TIMEOUT_PROFILE_KEY, 'upload' satisfies RequestTimeoutProfile);
