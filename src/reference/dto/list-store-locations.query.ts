import { IsOptional, IsString } from 'class-validator';

/** Query params for GET /reference/store-locations. Both filters are optional. */
export class ListStoreLocationsQuery {
  /** Case-insensitive substring match on name (ILIKE). */
  @IsOptional()
  @IsString()
  search?: string;

  /** Exact-match province filter. */
  @IsOptional()
  @IsString()
  province?: string;
}
