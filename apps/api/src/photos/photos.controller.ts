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
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { PhotosService } from './photos.service';
import { CreatePhotoDto } from './dto/create-photo.dto';

@Controller('assets/:assetId/photos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PhotosController {
  constructor(private photos: PhotosService) {}

  @RequirePermissions('assets', 'goods_in')
  @Get()
  list(@Param('assetId') assetId: string) {
    return this.photos.listForAsset(assetId);
  }

  @RequirePermissions('assets', 'goods_in')
  @Get(':id')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async data(
    @Param('assetId') assetId: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { data, contentType } = await this.photos.getData(assetId, id);
    return new StreamableFile(data, { type: contentType });
  }

  @RequirePermissions('assets', 'goods_in')
  @Post()
  create(
    @Param('assetId') assetId: string,
    @Body() dto: CreatePhotoDto,
    @Req() req: any,
  ) {
    return this.photos.create(assetId, dto, req.user.userId);
  }

  @RequirePermissions('manage_photos')
  @Delete(':id')
  remove(@Param('assetId') assetId: string, @Param('id') id: string) {
    return this.photos.remove(assetId, id);
  }
}
