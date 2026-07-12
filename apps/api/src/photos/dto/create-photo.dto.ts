import { IsOptional, IsString } from 'class-validator';

export class CreatePhotoDto {
  // Base64-encoded image bytes (no data: URI prefix).
  @IsString() data: string;

  @IsString() contentType: string;

  @IsOptional() @IsString() caption?: string;
}
