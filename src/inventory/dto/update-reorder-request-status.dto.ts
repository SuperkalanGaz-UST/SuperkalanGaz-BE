import { IsIn } from 'class-validator';

// 'Pending' is only ever the creation default, never a transition target.
const TARGET_STATUSES = ['Approved', 'Delivered', 'Cancelled'] as const;
export type ReorderRequestTargetStatus = (typeof TARGET_STATUSES)[number];

export class UpdateReorderRequestStatusDto {
  @IsIn(TARGET_STATUSES)
  status!: ReorderRequestTargetStatus;
}
