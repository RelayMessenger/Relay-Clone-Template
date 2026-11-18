// The person's own clock. Relay puts each person's IANA timezone on their
// handle in every agent event (`ChatHandle.timezone`, as
// their Relay app last reported it, null until it reports one).

/** A break this long or longer gets a time header, as in Messages. */
const BREAK_MS = 60 * 60 * 1_000;

/**
 * Chat-app times for a list of Messages in one person's timezone, oldest
 * first, shown the way Messages shows a time header: on the first message and
 * on a message that comes an hour or more after the one before it, nothing on
 * the rest. A header reads "Thu 3:14 AM", with the date added on the first one
 * and whenever the day changes ("Thu, Nov 5, 3:14 AM"). Data only, so the
 * model can see a gap (without times, clones took a night's sleep for
 * someone who never went to bed; a time on every line drew 25 clone
 * mentions of sleep, the hour or going outside in one night).
 */
export function chatTimes(dates: ReadonlyArray<Date | undefined>, timezone: string): Array<string | undefined> {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
  const dated = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  let previousDay: string | undefined;
  let previousAt: number | undefined;
  return dates.map((date) => {
    if (!date || Number.isNaN(date.getTime())) return undefined;
    const at = date.getTime();
    const header = previousAt === undefined || at - previousAt >= BREAK_MS;
    previousAt = at;
    if (!header) return undefined;
    const today = day.format(date);
    const label = (today === previousDay ? time : dated).format(date).replace(/ /g, " ");
    previousDay = today;
    return label;
  });
}
