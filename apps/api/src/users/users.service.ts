import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { IsNull, Not, Repository } from 'typeorm';
import { User, UserRole } from './user.entity';
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

  // Disable (or re-enable) an account. The alternative to remove(): deletion
  // SET NULLs this user off every audit, wipe and sale they touched, which
  // destroys the trail an ITAD client may later ask about. This keeps the
  // record and stops the access.
  //
  // Enforcement lives in PermissionsGuard and AuthService, NOT the JWT — the
  // token cannot be revoked and lives 12h. Busting the authz cache here is
  // what makes a disable land within seconds rather than at the 30s TTL.
  async setDisabled(id: string, disabled: boolean, requestingUserId: string): Promise<SafeUser> {
    if (id === requestingUserId) {
      // Symmetric with remove(). Locking yourself out of the only account that
      // can unlock accounts is not recoverable from the UI.
      throw new BadRequestException('You cannot disable your own account');
    }
    const user = await this.findEntity(id);

    if (disabled && user.role === UserRole.ADMIN) {
      // Disabling the last usable admin leaves nobody who can re-enable
      // anyone. Counts only admins who are currently enabled, so two admins
      // where one is already disabled still trips this.
      const otherEnabledAdmins = await this.users.count({
        where: { role: UserRole.ADMIN, disabledAt: IsNull(), id: Not(id) },
      });
      if (otherEnabledAdmins === 0) {
        throw new BadRequestException(
          'This is the only active admin. Promote another admin first, or nobody will be able to re-enable accounts.',
        );
      }
    }

    await this.users.update(id, {
      disabledAt: disabled ? new Date() : null,
      disabledById: disabled ? requestingUserId : null,
    });
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
