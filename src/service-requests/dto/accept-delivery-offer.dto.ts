import { IsOptional, IsUUID } from 'class-validator';

export class AcceptDeliveryOfferDto {
  @IsOptional()
  @IsUUID()
  vehicleId?: string;
}
