import { Controller, Get } from '@nestjs/common';
import { SkipRateLimit } from './rate-limit/rate-limit.decorator.js';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Platform health checks must never be starved by abuse counters.
  @Get('health')
  @SkipRateLimit()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}
