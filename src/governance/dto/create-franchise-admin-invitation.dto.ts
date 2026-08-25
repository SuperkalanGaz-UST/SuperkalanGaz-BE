import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateFranchiseAdminInvitationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;
}
