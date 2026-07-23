import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLog } from './activity-log.entity';
import { ActivityService } from './activity.service';
import { ActivityController } from './activity.controller';

// Global so any service can inject ActivityService without importing this module
// everywhere (it's a cross-cutting audit-trail concern).
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ActivityLog])],
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
