import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { isTokenStale } from './permissions.service';

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
    // Checked AFTER the password compare on purpose. Saying "disabled" to
    // someone who has already proved the password leaks nothing an attacker
    // could use, and it tells the actual person why they cannot get in instead
    // of leaving them retyping a password that is correct.
    if (user.disabledAt) {
      throw new UnauthorizedException(
        'This account has been disabled. Contact an administrator.',
      );
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
      // Without this the exposure is not the 12h access token but the 7-day
      // refresh window: the web middleware silently refreshes on every
      // protected navigation, so a disabled user with a tab open would renew
      // their own session indefinitely and the access expiry would never bite.
      if (user.disabledAt) throw new UnauthorizedException('Account disabled');
      // Same reasoning: a refresh token minted before a password reset must not
      // be exchangeable for a fresh access token, or the reset only holds for
      // 12h instead of ending the session.
      if (isTokenStale(payload.iat, user.passwordChangedAt?.getTime() ?? null)) {
        throw new UnauthorizedException('Password changed');
      }
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
      // permissions ride in the RESPONSE BODY, never the token: the JWT's
      // shape is a contract with PowerSync (aud/kid above), and a token-borne
      // grant would outlive an admin's edit by up to 12 hours anyway.
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
      },
    };
  }

  // DB-fresh identity for /auth/me — role and permissions as they are NOW,
  // not as they were when the token was minted. This is what the web reads to
  // decide nav/landing, so an admin's grant edit shows up on the next page
  // load instead of after a token refresh.
  async me(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('This account no longer exists');
    // AuthController carries only JwtAuthGuard — PermissionsGuard never runs on
    // this route, so the disabled check cannot be inherited from there. The web
    // reads /auth/me to decide nav and landing page; without this it would
    // render a fully signed-in shell for a disabled account.
    if (user.disabledAt) throw new UnauthorizedException('This account has been disabled');
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      permissions: user.permissions,
    };
  }
}
