import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity.js';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // Includes passwordHash (normally excluded via select: false on the
  // column) — only for use during login.
  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email: email.trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        role: true,
        businessId: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }
}
