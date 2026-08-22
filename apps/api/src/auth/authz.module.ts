import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { PermissionsService } from './permissions.service';

// @Global so PermissionsGuard — attached via @UseGuards on 20 controllers in
// 16 feature modules — can inject PermissionsService without every one of
// those modules importing TypeOrmModule.forFeature([User]) itself. The User
// repository is wired exactly once, here.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class AuthzModule {}
