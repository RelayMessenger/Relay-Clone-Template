export function validateTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function getZonedParts(date: Date, timezone: string): LocalParts & { weekday: number } {
  let format = zonedFormatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    zonedFormatters.set(timezone, format);
  }
  const parts = format.formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")),
  };
}

/** "Tue 2026-09-29 06:00 America/Detroit", or UTC when no zone is known. */
export function describeInstant(date: Date, timezone: string | undefined): string {
  const zone = timezone ?? "UTC";
  const parts = getZonedParts(date, zone);
  const pad = (value: number) => String(value).padStart(2, "0");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parts.weekday];
  return `${weekday} ${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)} ${zone}`;
}
