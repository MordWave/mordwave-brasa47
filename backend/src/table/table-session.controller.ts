import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { QrTokenDto } from './dto/qr-token.dto.js';
import { SessionStatusQueryDto } from './dto/session-status-query.dto.js';
import { JoinResult, ResolveResult, SessionStatusResult, TableSessionService } from './table-session.service.js';

// Public, unauthenticated — a customer's device checks in against its
// table's qrToken. See TableSession's own notes on the security caveat
// this still carries (table identification is a token, not a verified
// physical presence check). Every route shares one rate limit — see
// TableModule for the actual numbers. None of these create a REST
// "resource" in the usual sense (that's POST /orders, POST /tables, ...),
// so — same as AuthController's login — they return 200, not the POST
// default of 201.
@Controller('table-sessions')
export class TableSessionController {
  constructor(private readonly tableSessionService: TableSessionService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  resolve(@Body() dto: QrTokenDto): Promise<ResolveResult> {
    return this.tableSessionService.resolve(dto.qrToken);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  join(@Body() dto: QrTokenDto): Promise<JoinResult> {
    return this.tableSessionService.join(dto.qrToken);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  status(@Body() dto: SessionStatusQueryDto): Promise<SessionStatusResult> {
    return this.tableSessionService.status(dto.sessionToken);
  }
}
