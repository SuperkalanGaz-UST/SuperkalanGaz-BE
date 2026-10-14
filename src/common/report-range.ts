import { BadRequestException } from '@nestjs/common';
import { BranchReportQuery } from './dto/branch-report.query';

const MANILA_UTC_OFFSET = '+08:00';
const MAX_REPORT_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportRange {
  start: Date;
  endExclusive: Date;
}

function isCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Converts inclusive Philippine calendar dates into a half-open timestamp
 * range. Half-open bounds avoid losing records with sub-millisecond precision
 * at the end of the selected day.
 */
export function reportRangeFrom(query: BranchReportQuery): ReportRange {
  if (!isCalendarDate(query.from) || !isCalendarDate(query.to)) {
    throw new BadRequestException('Report dates must be valid calendar dates');
  }

  const start = new Date(`${query.from}T00:00:00${MANILA_UTC_OFFSET}`);
  const inclusiveEnd = new Date(`${query.to}T00:00:00${MANILA_UTC_OFFSET}`);
  const endExclusive = new Date(inclusiveEnd.getTime() + DAY_MS);

  if (start > inclusiveEnd) {
    throw new BadRequestException('Report start date cannot be after the end date');
  }
  if (endExclusive.getTime() - start.getTime() > MAX_REPORT_DAYS * DAY_MS) {
    throw new BadRequestException(`Report range cannot exceed ${MAX_REPORT_DAYS} days`);
  }

  return { start, endExclusive };
}
