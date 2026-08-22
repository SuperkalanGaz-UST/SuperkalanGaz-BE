/**
 * Configuration for the loyalty points feature.
 * Defines the number of household points earned per completed cylinder purchase.
 */
export const DEFAULT_CYLINDER_POINTS = {
  '2.7kg': 5,
  '5kg': 10,
  '11kg': 15,
  '22kg': 20,
  '50kg': 25,
} as const;
