import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { GoTrueAdminService } from './gotrue-admin.service';
import { Profile } from './profile.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([Profile]), AuthModule],
  controllers: [UsersController],
  providers: [UsersService, GoTrueAdminService],
})
export class UsersModule {}
