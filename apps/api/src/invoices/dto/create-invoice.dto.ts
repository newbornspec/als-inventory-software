import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateInvoiceDto {
  // --- buyer -----------------------------------------------------------------
  // Name is the only mandatory buyer field. An invoice with no name is not an
  // invoice; an invoice to a trade counter with no postcode is ordinary.
  @IsString()
  @IsNotEmpty({ message: 'Buyer name is required.' })
  @MaxLength(200)
  buyerName: string;

  @IsOptional() @IsString() @MaxLength(200) buyerAddress1?: string;
  @IsOptional() @IsString() @MaxLength(200) buyerAddress2?: string;
  @IsOptional() @IsString() @MaxLength(120) buyerCity?: string;
  @IsOptional() @IsString() @MaxLength(20) buyerPostcode?: string;
  @IsOptional() @IsString() @MaxLength(120) buyerCountry?: string;

  // --- VAT -------------------------------------------------------------------
  @IsBoolean({ message: 'Say whether the business is VAT registered.' })
  vatRegistered: boolean;

  // Required ONLY when registered. ValidateIf skips the rest of the chain
  // entirely when not registered, so an empty box is not an error for a
  // business that has nothing to put in it.
  @ValidateIf((o: CreateInvoiceDto) => o.vatRegistered === true)
  @IsString()
  @IsNotEmpty({ message: 'VAT registration number is required when VAT registered.' })
  @MaxLength(40)
  vatNumber?: string;

  @ValidateIf((o: CreateInvoiceDto) => o.vatRegistered === true)
  @Type(() => Number)
  @IsNumber({}, { message: 'VAT rate is required when VAT registered.' })
  @Min(0, { message: 'VAT rate cannot be negative.' })
  @Max(100, { message: 'VAT rate cannot be more than 100%.' })
  vatRate?: number;

  // --- document --------------------------------------------------------------
  // Defaults to today server-side when omitted; accepted so a back-dated
  // invoice can be raised without editing the PDF afterwards.
  @IsOptional() @IsDateString({}, { message: 'Invoice date must be a valid date.' })
  invoiceDate?: string;

  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
