import { advanceMileage, DistanceReading, MileageCursor } from './gps-mileage';

describe('GPS mileage conversion', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const cursor: MileageCursor = { totalDistanceM: null, remainderM: 0, positionAt: null, baselineAfter: start };
  const reading = (metres: number, minutes = 1): DistanceReading => ({
    deviceId: '41', totalDistanceM: metres, positionAt: new Date(start.getTime() + minutes * 60_000),
  });

  it('anchors the initial device total without replacing or increasing the entered odometer', () => {
    expect(advanceMileage(cursor, reading(500_000))).toMatchObject({ kilometres: 0, remainderM: 0, totalDistanceM: 500_000 });
  });

  it('catches up from cumulative distance and carries sub-kilometre travel between polls', () => {
    const initial = { ...cursor, ...advanceMileage(cursor, reading(500_000)) };
    const short = advanceMileage(initial, reading(500_650, 2))!;
    expect(short).toMatchObject({ kilometres: 0, remainderM: 650 });
    const next = advanceMileage({ ...initial, ...short }, reading(501_300, 120))!;
    expect(next).toMatchObject({ kilometres: 1, remainderM: 300 });
  });

  it('ignores duplicates, delayed reports and positions before a manual recalibration', () => {
    const initial = { ...cursor, ...advanceMileage(cursor, reading(500_000, 5)) };
    expect(advanceMileage(initial, reading(502_000, 4))).toBeNull();
    expect(advanceMileage(initial, reading(500_000, 5))).toBeNull();
    expect(advanceMileage({ ...cursor, baselineAfter: reading(0, 10).positionAt }, reading(502_000, 9))).toBeNull();
  });

  it('rebaselines a counter reset without decreasing the odometer or adding historical travel again', () => {
    const initial = { ...cursor, totalDistanceM: 500_000, remainderM: 800, positionAt: start };
    const reset = advanceMileage(initial, reading(200))!;
    expect(reset).toMatchObject({ kilometres: 0, remainderM: 0, status: 'counter-reset' });
    expect(advanceMileage({ ...initial, ...reset }, reading(1500, 2))).toMatchObject({ kilometres: 1, remainderM: 300 });
  });

  it.each([NaN, Infinity, -1, 1e12])('rejects unusable distance %s', (distance) => {
    expect(advanceMileage(cursor, reading(distance))).toBeNull();
  });

  it('rejects future timestamps', () => {
    expect(advanceMileage(cursor, { ...reading(1000), positionAt: new Date(Date.now() + 120_000) })).toBeNull();
  });
});
