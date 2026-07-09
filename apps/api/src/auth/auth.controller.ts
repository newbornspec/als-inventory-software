import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto) {
    const user = await this.auth.validateUser(dto.email, dto.password);
    return this.auth.login(user);
  }

  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.auth.refresh(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('me')
  me(@Req() req: any) {
    return req.user;
  }

  // Stateless JWT: "logout" is enforced client-side by discarding the token.
  // If server-side revocation is needed later, back this with a token-blocklist store.
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout() {
    return { message: 'Logged out' };
  }
}
