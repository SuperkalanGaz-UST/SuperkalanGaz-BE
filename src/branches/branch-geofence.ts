import { BadRequestException } from '@nestjs/common';
import { BranchGeofence } from './branch.entity';

function coordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === 'number' && Number.isFinite(value[0]) && Math.abs(value[0]) <= 90 &&
    typeof value[1] === 'number' && Number.isFinite(value[1]) && Math.abs(value[1]) <= 180;
}

/** Recompute circle vertices at the API boundary; client geometry is never authoritative. */
export function normalizeGeofence(value: unknown): BranchGeofence | null {
  if (value === null || value === undefined) return null;
  const fail = (): never => { throw new BadRequestException('Invalid geofence: supply a polygon or a branch centre and a radius from 100 to 50000 metres'); };
  if (!value || typeof value !== 'object') return fail();
  const input = value as Record<string, unknown>;
  if (input.type !== 'polygon') return fail();
  if (input.center !== undefined && !coordinate(input.center)) return fail();
  const center = input.center as [number, number] | undefined;
  if (input.radiusMeters !== undefined) {
    const radius = input.radiusMeters;
    if (!center || typeof radius !== 'number' || !Number.isFinite(radius) || radius < 100 || radius > 50000) return fail();
    const angularDistance = radius / 6371000;
    const latitude = center[0] * Math.PI / 180;
    const longitude = center[1] * Math.PI / 180;
    const points = Array.from({ length: 96 }, (_, index): [number, number] => {
      const bearing = index * 2 * Math.PI / 96;
      const lat = Math.asin(Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing));
      const lng = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(lat));
      return [lat * 180 / Math.PI, ((lng * 180 / Math.PI + 540) % 360) - 180];
    });
    return { type: 'polygon', center, radiusMeters: radius, points };
  }
  if (!Array.isArray(input.points) || input.points.length < 3 || input.points.length > 1000 || !input.points.every(coordinate)) return fail();
  return { type: 'polygon', points: input.points, ...(center ? { center } : {}) };
}
