import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class AcceptBranchManagerInvitationDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/\d/, { message: 'Password must include a number' })
  password!: string;
}
