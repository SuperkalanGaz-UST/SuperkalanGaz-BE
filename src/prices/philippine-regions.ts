/** PSA PSGC region names, verified 2026-10-14: https://psa.gov.ph/classification/psgc/regions */
export const PHILIPPINE_REGIONS = [
  { code: 'NCR', name: 'Metro Manila (NCR)' },
  { code: 'IV-A', name: 'CALABARZON (Region IV-A)' },
  { code: 'III', name: 'Central Luzon (Region III)' },
  { code: 'CAR', name: 'Cordillera Administrative Region (CAR)' },
  { code: 'I', name: 'Ilocos Region (Region I)' },
  { code: 'II', name: 'Cagayan Valley (Region II)' },
  { code: 'MIMAROPA', name: 'MIMAROPA' },
  { code: 'V', name: 'Bicol Region (Region V)' },
  { code: 'VI', name: 'Western Visayas (Region VI)' },
  { code: 'VII', name: 'Central Visayas (Region VII)' },
  { code: 'VIII', name: 'Eastern Visayas (Region VIII)' },
  { code: 'IX', name: 'Zamboanga Peninsula (Region IX)' },
  { code: 'X', name: 'Northern Mindanao (Region X)' },
  { code: 'XI', name: 'Davao Region (Region XI)' },
  { code: 'XII', name: 'SOCCSKSARGEN (Region XII)' },
  { code: 'XIII', name: 'Caraga (Region XIII)' },
  { code: 'NIR', name: 'Negros Island Region (NIR)' },
  {
    code: 'BARMM',
    name: 'Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)',
  },
] as const;

export type RegionCode = (typeof PHILIPPINE_REGIONS)[number]['code'];
export const REGION_CODES = PHILIPPINE_REGIONS.map((region) => region.code);

export function isRegionCode(value: unknown): value is RegionCode {
  return (
    typeof value === 'string' && REGION_CODES.includes(value as RegionCode)
  );
}
