import cron from "node-cron";

const RAW_OFFSET_TIMEZONE_RE = /^(?:UTC|GMT)?[+-]\d{1,2}(?::?\d{2})?$/i;

export function isValidIanaTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  const trimmed = tz.trim();
  if (RAW_OFFSET_TIMEZONE_RE.test(trimmed)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isRawOffsetTimezone(tz) {
  return typeof tz === "string" && RAW_OFFSET_TIMEZONE_RE.test(tz.trim());
}

export function hasUnsupportedCronFieldCount(expression) {
  return (
    typeof expression !== "string" ||
    expression.trim().split(/\s+/).length !== 5
  );
}

export function isSupportedFiveFieldCron(expression) {
  return (
    !hasUnsupportedCronFieldCount(expression) && cron.validate(expression)
  );
}

function expandCronField(field, max) {
  const values = new Set();

  for (const part of field.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;

    const start = match[1] === "*" ? 0 : Number(match[1]);
    const end = match[2] === undefined
      ? (match[1] === "*" ? max : start)
      : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      !Number.isInteger(step) ||
      start < 0 ||
      end > max ||
      start > end ||
      step < 1
    ) {
      return null;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values.size > 0 ? values : null;
}

export function isCronTooFrequent(expression) {
  if (hasUnsupportedCronFieldCount(expression)) return true;
  const [minute, hour] = expression.trim().split(/\s+/);

  const minutes = expandCronField(minute, 59);
  if (!minutes) return true;
  const hours = expandCronField(hour, 23);
  if (!hours) return true;

  const dayMinutes = new Set();
  for (const h of hours) {
    for (const m of minutes) {
      dayMinutes.add(h * 60 + m);
    }
  }
  const sorted = [...dayMinutes].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] < 5) return true;
  }
  if (sorted.length >= 2) {
    const wrap = 24 * 60 - sorted[sorted.length - 1] + sorted[0];
    if (wrap < 5) return true;
  }

  return false;
}

export function subHourlyIntervalMinutes(expression) {
  if (hasUnsupportedCronFieldCount(expression)) return null;
  const [minute] = expression.trim().split(/\s+/);
  const minutes = expandCronField(minute, 59);
  if (!minutes || minutes.size < 2) return null;
  return Math.round(60 / minutes.size);
}

export function timezoneObservesDst(zone) {
  try {
    const offsetOf = (date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "shortOffset",
      })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value;
    const january = offsetOf(new Date(Date.UTC(2026, 0, 1)));
    const july = offsetOf(new Date(Date.UTC(2026, 6, 1)));
    return Boolean(january && july && january !== july);
  } catch {
    return false;
  }
}

export function dstFallBackWarning(expression, timezone, label) {
  const interval = subHourlyIntervalMinutes(expression);
  if (interval === null || interval < 15 || interval > 60) return null;
  if (!timezoneObservesDst(timezone)) return null;
  const name = label ? `"${label}" ` : "";
  return (
    `Schedule ${name}fires roughly every ${interval} minute(s); during ` +
    `${timezone}'s daylight-saving fall-back each year, one occurrence in ` +
    "the repeated hour will be silently skipped -- this is a limitation of " +
    "the underlying scheduler (node-cron), not a bug in the panel."
  );
}
