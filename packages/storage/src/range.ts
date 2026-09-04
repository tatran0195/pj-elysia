import * as errors from './errors.js';
import type { RangeRequest } from './types.js';

export function isRangeRequest(range?: RangeRequest): range is RangeRequest {
  return range !== undefined && (range.start !== undefined || range.end !== undefined);
}

export function validateRangeRequest(key: string, range: RangeRequest): void {
  const { start, end } = range;

  if (start !== undefined && (!Number.isInteger(start) || start < 0)) {
    throw new errors.E_RANGE_UNSATISFIABLE([key]);
  }

  if (end !== undefined && (!Number.isInteger(end) || end < 0)) {
    throw new errors.E_RANGE_UNSATISFIABLE([key]);
  }

  if (start !== undefined && end !== undefined && start > end) {
    throw new errors.E_RANGE_UNSATISFIABLE([key]);
  }
}

export function validateRangeSatisfiable(
  key: string,
  range: RangeRequest,
  contentLength: number,
): void {
  const { start, end } = range;

  if (start !== undefined && start >= contentLength) {
    throw new errors.E_RANGE_UNSATISFIABLE([key]);
  }

  if (end !== undefined && end >= contentLength) {
    throw new errors.E_RANGE_UNSATISFIABLE([key]);
  }
}
