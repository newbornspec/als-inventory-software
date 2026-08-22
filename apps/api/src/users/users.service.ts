import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { sanitizeUser, type SafeUser } from './sanitize-user';
import { DEFAULT_PERMISSIONS } from '../auth/permissions';
import { PermissionsService } from '../auth/permissions.service';

export type { SafeUser };

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    private permissionsCache: PermissionsService,
  ) {}

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
      this.users.create({
        name: dto.name,
        email: dto.email,
        passwordHash,
        role: dto.role,
        // No explicit grants -> the role's baseline set. Explicit grants win
        // outright — that's the whole point of per-user permissions.
        permissions: dto.permissions ?? DEFAULT_PERMISSIONS[dto.role],
      }),
    );
    return sanitizeUser(saved);
  }

  async update(id: string, dto: UpdateUserDto): Promise<SafeUser> {
    await this.findEntity(id);
    // A role change WITHOUT explicit grants resets permissions to the new
    // role's baseline. Predictable over clever: the inline role dropdown on
    // the Users page sends only a role, and "promote to manager" should mean
    // the manager baseline — not the old role's grants wearing a new label.
    // Sending permissions alongside the role suppresses the reset.
    const patch: Partial<User> = { ...dto };
    if (dto.role && dto.permissions === undefined) {
      patch.permissions = DEFAULT_PERMISSIONS[dto.role];
    }
    await this.users.update(id, patch);
    // Bust the guard's cache so the edit lands on the next request, not after
    // the 30s TTL.
    this.permissionsCache.invalidate(id);
    return this.findOne(id);
  }

  async remove(id: string, requestingUserId: string): Promise<void> {
    if (id === requestingUserId) {
      throw new BadRequestException('You cannot delete your own account');
    }
    await this.findEntity(id);
    await this.users.delete(id);
    this.permissionsCache.invalidate(id);
  }

  private async findEntity(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }
}
