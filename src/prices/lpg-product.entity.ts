import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

const decimalTransformer = {
  to: (value: number) => value,
  from: (value: string) => Number(value),
};

/** Shared LPG catalog. It is intentionally branch-independent. */
@Entity({ schema: 'srd', name: 'products' })
export class LpgProduct {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  sku!: string | null;

  @Column({
    name: 'cylinder_size_kg',
    type: 'numeric',
    precision: 5,
    scale: 1,
    nullable: true,
    transformer: decimalTransformer,
  })
  cylinderSizeKg!: number;

  @Column({
    name: 'base_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  basePrice!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  get cylinderSize(): string {
    return `${this.cylinderSizeKg}kg`;
  }

  get unitPrice(): number {
    return this.basePrice;
  }

  set unitPrice(value: number) {
    this.basePrice = value;
  }
}
