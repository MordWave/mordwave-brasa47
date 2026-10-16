import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { businessInactiveError } from '../business/business-active.js';
import { Business } from '../business/business.entity.js';
import { UserRole } from '../user/user-role.enum.js';

// Single place that decides whether an account may operate given the state of ITS business, used both when logging
// in and on every authenticated request (JwtStrategy), so a token issued before a suspension stops authorizing
// anything as soon as the business is suspended. Only the SUPER_ADMIN is exempt: they are not bound to a tenant, and
// whichever business they are looking at never limits them (that is how a suspended business gets reactivated).
// Every other role is checked, so a role added later is covered by default.
//
// One primary-key lookup of a single column; deliberately not cached, so a suspension takes effect on the next request.
@Injectable()
export class BusinessAccessService {
  constructor(
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
  ) {}

  async assertBusinessActive(user: { role: UserRole; businessId: string | null }): Promise<void> {
    if (user.role === UserRole.SUPER_ADMIN) return;
    // No business at all is not a suspension: the existing per-route checks (tenant.util) already answer 403 for it.
    if (!user.businessId) return;

    const business = await this.businessRepository.findOne({
      select: { id: true, active: true },
      where: { id: user.businessId },
    });
    if (business?.active !== true) throw businessInactiveError();
  }
}
