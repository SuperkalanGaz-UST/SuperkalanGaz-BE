import { BadRequestException } from '@nestjs/common';
import { reportRangeFrom } from './report-range';

describe('reportRangeFrom', () => {
  it('uses inclusive Philippine calendar dates with an exclusive upper bound', () => {
    const range = reportRangeFrom({ from: '2026-05-01', to: '2026-05-31' });

    expect(range.start.toISOString()).toBe('2026-04-30T16:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-05-31T16:00:00.000Z');
  });

  it('rejects reversed and impossible dates', () => {
    expect(() => reportRangeFrom({ from: '2026-06-01', to: '2026-05-31' })).toThrow(
      BadRequestException,
    );
    expect(() => reportRangeFrom({ from: '2026-02-30', to: '2026-03-01' })).toThrow(
      BadRequestException,
    );
  });
});
