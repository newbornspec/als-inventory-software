import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async validateUser(email: string, password: string): Promise<User> {
    const user = await this.users.findOne({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  async login(user: User) {
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>('jwt.secret'),
      });
      const user = await this.users.findOneOrFail({ where: { id: payload.sub } });
      return this.issueTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private issueTokens(user: User) {
    // 'aud' matches the audience PowerSync's client_auth config checks
    // (see powersync/service.yaml) — without it, PowerSync rejects an
    // otherwise-valid, correctly-signed token from this same auth module.
    const payload = { sub: user.id, email: user.email, role: user.role, aud: 'als-inventory' };

    // keyid must match the `kid` on the JWK in powersync/service.yaml's
    // client_auth — PowerSync looks up the verification key by kid and
    // rejects the token (PSYNC_S2101) if the JWT header doesn't carry one.
    const accessToken = this.jwt.sign(payload, {
      expiresIn: this.config.get<string>('jwt.expiresIn') as never,
      keyid: 'als-inventory-hs256',
    });
    const refreshToken = this.jwt.sign(payload, {
      expiresIn: this.config.get<string>('jwt.refreshExpiresIn') as never,
      keyid: 'als-inventory-hs256',
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'bearer',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }
}
