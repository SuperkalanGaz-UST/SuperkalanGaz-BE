import { IsNotEmpty, IsUUID } from 'class-validator';

/** The Branch Manager chooses the Delivery Rider for the offer. NestJS
 * derives the branch and records dispatch only after acceptance. */
export class DispatchServiceRequestDto {
  @IsUUID()
  @IsNotEmpty()
  riderId!: string;
}
