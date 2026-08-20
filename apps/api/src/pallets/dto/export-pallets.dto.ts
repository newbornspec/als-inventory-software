import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

// The selection to export. A body rather than a query string: select-all over a
// few hundred pallets is a normal thing to do, and 300 uuids is ~11k of URL —
// past what proxies and access logs will take.
export class ExportPalletsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  ids!: string[];
}
