import {
  Controller,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { Principal } from '../auth/principal';
import { CurrentPrincipal, Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { FleetService } from '../fleet/fleet.service';
import { ServiceRequestsService } from './service-requests.service';
import type { DeliveryProofUpload } from './service-requests.service';
import {
  DELIVERY_PROOF_ALLOWED_MIME_TYPES,
  DELIVERY_PROOF_MAX_BYTES,
  isDeliveryProofMimeType,
} from './delivery-proof.constants';

/** Delivery Rider milestone writes. This is separate from the Branch Manager
 * queue controller so the route remains explicitly role-gated and the mobile
 * client can use the delivery-rider URL namespace. */
@Controller('delivery-rider/service-requests')
@UseGuards(AuthGuard, RolesGuard)
@Roles('driver')
export class DeliveryRiderServiceRequestsController {
  constructor(
    private readonly serviceRequests: ServiceRequestsService,
    private readonly fleet: FleetService,
  ) {}

  @Post(':id/deliver')
  @UseInterceptors(FileInterceptor('proof', {
    limits: { files: 1, fileSize: DELIVERY_PROOF_MAX_BYTES },
    fileFilter: (_request, file, callback) => {
      if (isDeliveryProofMimeType(file.mimetype)) {
        callback(null, true);
        return;
      }
      callback(
        new BadRequestException(
          `Proof must be a ${DELIVERY_PROOF_ALLOWED_MIME_TYPES.join(' or ')} image`,
        ),
        false,
      );
    },
  }))
  async deliver(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) serviceRequestId: string,
    @UploadedFile() proof?: DeliveryProofUpload,
  ) {
    await this.serviceRequests.deliver(principal, serviceRequestId, proof);
    return this.fleet.deliveryRiderDashboard(principal);
  }
}
