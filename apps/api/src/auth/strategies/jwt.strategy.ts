import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  // Issued-at, in SECONDS since the epoch. jsonwebtoken adds it automatically;
  // nothing had to be added to the token to get it, which matters because the
  // JWT's shape is a contract with PowerSync (see auth.service issueTokens).
  // Compared against users.password_changed_at so a password reset ends
  // sessions that were minted before it.
  iat?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret')!,
    });
  }

  validate(payload: JwtPayload) {
    // Attached to request.user by Passport — kept minimal on purpose.
    // issuedAt rides along so PermissionsGuard can reject a token minted before
    // the account's password was reset. It is NOT authorization data: role here
    // is still up to 12h stale and the guard ignores it in favour of the DB.
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      issuedAt: payload.iat ?? null,
    };
  }
}
