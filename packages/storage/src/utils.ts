export function toUnixSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

export function condenseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const TIME_FACTORS: Record<string, number> = {
  s: 1,
  sec: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

export function parseDurationToSeconds(duration: string | number): number {
  if (typeof duration === 'number') {
    return duration;
  }

  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) {
    const parsed = Number(duration);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const factor = TIME_FACTORS[unit] ?? 1;
  return Math.round(amount * factor);
}
