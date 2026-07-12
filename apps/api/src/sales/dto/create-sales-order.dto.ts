import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { SalesOrderStatus } from '../sales-order.entity';

export class CreateSalesOrderDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() orderRef?: string;
  @IsOptional() @IsEnum(SalesOrderStatus) status?: SalesOrderStatus;
  @IsOptional() @IsString() notes?: string;
}
