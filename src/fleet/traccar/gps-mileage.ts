/** Cumulative distance is in metres in Traccar, independent of CRM odometer.
 * Never add Traccar's lifetime total to an existing motorcycle odometer. */
export interface MileageCursor {
  totalDistanceM: number | null;
  remainderM: number;
  positionAt: Date | null;
  baselineAfter: Date;
}

export interface DistanceReading {
  deviceId: string;
  totalDistanceM: number;
  positionAt: Date;
}

export function advanceMileage(cursor: MileageCursor, reading: DistanceReading) {
  const time = reading.positionAt.getTime();
  if (
    !Number.isFinite(reading.totalDistanceM) || reading.totalDistanceM < 0 || reading.totalDistanceM >= 1e12 ||
    !Number.isFinite(time) ||
    time < cursor.baselineAfter.getTime() ||
    time > Date.now() + 60_000 ||
    (cursor.positionAt && time <= cursor.positionAt.getTime())
  ) return null;

  const reset = cursor.totalDistanceM !== null && reading.totalDistanceM < cursor.totalDistanceM;
  const metres = cursor.totalDistanceM === null || reset
    ? 0
    : reading.totalDistanceM - cursor.totalDistanceM + cursor.remainderM;
  const kilometres = Math.floor(metres / 1000);
  return {
    kilometres,
    totalDistanceM: reading.totalDistanceM,
    remainderM: metres - kilometres * 1000,
    positionAt: reading.positionAt,
    status: reset ? 'counter-reset' as const : 'synced' as const,
  };
}
