import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsEnabledGuard } from './diagnostics-enabled.guard.js';

@Module({
  // AuthModule exports JwtAuthGuard/RolesGuard.
  imports: [AuthModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsEnabledGuard],
})
export class DiagnosticsModule {}
