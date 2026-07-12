import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { PhotosService } from './photos.service';
import { CreatePhotoDto } from './dto/create-photo.dto';

@Controller('assets/:assetId/photos')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PhotosController {
  constructor(private photos: PhotosService) {}

  @Get()
  list(@Param('assetId') assetId: string) {
    return this.photos.listForAsset(assetId);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async data(
    @Param('assetId') assetId: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { data, contentType } = await this.photos.getData(assetId, id);
    return new StreamableFile(data, { type: contentType });
  }

  @Post()
  create(
    @Param('assetId') assetId: string,
    @Body() dto: CreatePhotoDto,
    @Req() req: any,
  ) {
    return this.photos.create(assetId, dto, req.user.userId);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Delete(':id')
  remove(@Param('assetId') assetId: string, @Param('id') id: string) {
    return this.photos.remove(assetId, id);
  }
}
