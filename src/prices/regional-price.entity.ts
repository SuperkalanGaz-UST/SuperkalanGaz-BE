import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { RegionCode } from './philippine-regions';

/** Regional prices reference the shared catalog; product identities never change. */
@Entity({ schema: 'srd', name: 'regional_prices' })
@Index(['regionCode', 'productId'], { unique: true })
@Index(['productId'])
export class RegionalPrice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'region_code', type: 'text' })
  regionCode!: RegionCode;

  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @Column({
    name: 'unit_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => Number(value),
    },
  })
  unitPrice!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
