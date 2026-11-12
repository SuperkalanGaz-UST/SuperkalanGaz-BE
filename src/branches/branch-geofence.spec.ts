import { BadRequestException } from '@nestjs/common';
import { normalizeGeofence } from './branch-geofence';

const distance = (a: number[], b: number[]) => {
  const radians = (n: number) => n * Math.PI / 180;
  const h = Math.sin(radians(b[0] - a[0]) / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(radians(b[1] - a[1]) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

describe('branch geofence integrity', () => {
  it('recomputes circle geometry from the chosen centre and metre radius', () => {
    const center = [14.5995, 120.9842];
    const fence = normalizeGeofence({ type: 'polygon', center, radiusMeters: 2500, points: [[0, 0]] });
    expect(fence?.points).toHaveLength(96);
    for (const point of fence!.points) expect(distance(center, point)).toBeCloseTo(2500, 5);
  });

  it('preserves legacy polygons and null coverage', () => {
    const polygon = { type: 'polygon', points: [[14, 121], [15, 121], [15, 122]] };
    expect(normalizeGeofence(polygon)).toEqual(polygon);
    expect(normalizeGeofence(null)).toBeNull();
  });

  it.each([
    { type: 'polygon', center: [91, 121], radiusMeters: 1000 },
    { type: 'polygon', center: [14, 121], radiusMeters: 0 },
    { type: 'polygon', center: [14, 121], radiusMeters: 50001 },
    { type: 'polygon', center: [14, 121], radiusMeters: NaN },
    { type: 'polygon', radiusMeters: 1000 },
    { type: 'polygon', points: [[14, 121], [15, 121]] },
    { type: 'polygon', points: [[14, 121], [15, 121], [NaN, 122]] },
  ])('rejects invalid geometry %#', (value) => {
    expect(() => normalizeGeofence(value)).toThrow(BadRequestException);
  });
});
