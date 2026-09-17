import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SafeUser } from '../safe-user.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SafeUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
