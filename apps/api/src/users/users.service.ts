import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { sanitizeUser, type SafeUser } from './sanitize-user';

export type { SafeUser };

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private users: Repository<User>) {}

  async findAll(): Promise<SafeUser[]> {
    const users = await this.users.find({ order: { name: 'ASC' } });
    return users.map(sanitizeUser);
  }

  async findOne(id: string): Promise<SafeUser> {
    return sanitizeUser(await this.findEntity(id));
  }

  async create(dto: CreateUserDto): Promise<SafeUser> {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A user with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const saved = await this.users.save(
      this.users.create({ name: dto.name, email: dto.email, passwordHash, role: dto.role }),
    );
    return sanitizeUser(saved);
  }

  async update(id: string, dto: UpdateUserDto): Promise<SafeUser> {
    await this.findEntity(id);
    await this.users.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string, requestingUserId: string): Promise<void> {
    if (id === requestingUserId) {
      throw new BadRequestException('You cannot delete your own account');
    }
    await this.findEntity(id);
    await this.users.delete(id);
  }

  private async findEntity(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }
}
