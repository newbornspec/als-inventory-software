import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetPhoto } from './asset-photo.entity';
import { Asset } from '../assets/asset.entity';
import { CreatePhotoDto } from './dto/create-photo.dto';
import { sanitizeUser } from '../users/sanitize-user';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per photo (client compresses well below this)

export interface PhotoMeta {
  id: string;
  assetId: string;
  contentType: string;
  caption: string | null;
  uploadedBy: { id: string; name: string } | null;
  createdAt: Date;
}

@Injectable()
export class PhotosService {
  constructor(
    @InjectRepository(AssetPhoto) private photos: Repository<AssetPhoto>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
  ) {}

  // Never selects the `data` blob (select:false on the column).
  async listForAsset(assetId: string): Promise<PhotoMeta[]> {
    const rows = await this.photos.find({
      where: { assetId },
      relations: ['uploadedBy'],
      order: { createdAt: 'DESC' },
    });
    return rows.map((p) => ({
      id: p.id,
      assetId: p.assetId,
      contentType: p.contentType,
      caption: p.caption,
      uploadedBy: p.uploadedBy
        ? { id: p.uploadedBy.id, name: sanitizeUser(p.uploadedBy).name }
        : null,
      createdAt: p.createdAt,
    }));
  }

  async getData(assetId: string, id: string): Promise<{ data: Buffer; contentType: string }> {
    const photo = await this.photos
      .createQueryBuilder('p')
      .addSelect('p.data')
      .where('p.id = :id', { id })
      .andWhere('p.assetId = :assetId', { assetId })
      .getOne();
    if (!photo) throw new NotFoundException(`Photo ${id} not found`);
    return { data: photo.data, contentType: photo.contentType };
  }

  async create(assetId: string, dto: CreatePhotoDto, userId: string): Promise<PhotoMeta> {
    await this.assertAsset(assetId);
    if (!dto.contentType.startsWith('image/')) {
      throw new BadRequestException('Only image files can be uploaded.');
    }
    const data = Buffer.from(dto.data, 'base64');
    if (data.length === 0) throw new BadRequestException('Empty image.');
    if (data.length > MAX_BYTES) {
      throw new BadRequestException('Image is too large (max 5 MB after compression).');
    }
    const saved = await this.photos.save(
      this.photos.create({
        assetId,
        data,
        contentType: dto.contentType,
        caption: dto.caption ?? null,
        uploadedById: userId,
      }),
    );
    return {
      id: saved.id,
      assetId: saved.assetId,
      contentType: saved.contentType,
      caption: saved.caption,
      uploadedBy: null,
      createdAt: saved.createdAt,
    };
  }

  async remove(assetId: string, id: string): Promise<void> {
    const photo = await this.photos.findOne({ where: { id, assetId } });
    if (!photo) throw new NotFoundException(`Photo ${id} not found`);
    await this.photos.delete(id);
  }

  private async assertAsset(id: string): Promise<void> {
    const count = await this.assets.countBy({ id });
    if (count === 0) throw new NotFoundException(`Asset ${id} not found`);
  }
}
