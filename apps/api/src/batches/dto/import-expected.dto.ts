import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

// One expected line as it comes off a parsed supplier file. Everything except
// quantity is optional — suppliers provide wildly different levels of detail.
export class ExpectedLineItemInput {
  @IsOptional() @IsString() assetTag?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() cpu?: string;

  @IsOptional() @IsInt() @Min(0) ramGb?: number;

  @IsOptional() @IsString() storage?: string;
  @IsOptional() @IsString() screenSize?: string;
  @IsOptional() @IsString() condition?: string;
  @IsOptional() @IsString() grade?: string;

  @IsOptional() @IsInt() @Min(1) quantity?: number;
}

export class ImportExpectedDto {
  @IsArray()
  @ArrayMaxSize(50000) // guardrail against a runaway upload
  @ValidateNested({ each: true })
  @Type(() => ExpectedLineItemInput)
  items: ExpectedLineItemInput[];
}
