import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { QrTokenDto } from './dto/qr-token.dto.js';
import { SessionStatusQueryDto } from './dto/session-status-query.dto.js';
import { JoinResult, SessionStatusResult, TableSessionService } from './table-session.service.js';

// Public, unauthenticated — a customer's device checks in against its
// table's qrToken. See TableSession's own notes on the security caveat
// this still carries (table identification is a token, not a verified
// physical presence check). Both routes share the 'table-sessions' named
// throttler from TableModule; `status` overrides its limit below since
// it's polled repeatedly by every device at a table (often sharing one IP
// behind the venue's own Wi-Fi), unlike the one-shot `join`. None of these
// create a REST "resource" in the usual sense (that's POST /orders,
// POST /tables, ...), so — same as AuthController's login — they return
// 200, not the POST default of 201.
@Controller('table-sessions')
export class TableSessionController {
  constructor(private readonly tableSessionService: TableSessionService) {}

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  join(@Body() dto: QrTokenDto): Promise<JoinResult> {
    return this.tableSessionService.join(dto.qrToken);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  // Raised well above the module's default 'table-sessions' limit — see
  // TableModule for the reasoning (many devices, one shared IP, 12s poll).
  @Throttle({ 'table-sessions': { limit: 300, ttl: 60_000 } })
  status(@Body() dto: SessionStatusQueryDto): Promise<SessionStatusResult> {
    return this.tableSessionService.status(dto.sessionToken);
  }
}
