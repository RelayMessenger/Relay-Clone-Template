import { describe, expect, it } from "vitest";

import { chatTimes } from "../src/person-time";

describe("chat times, the way Messages shows them", () => {
  it("shows a time only on the first message and after a break of an hour or more", () => {
    expect(chatTimes([
      new Date("2026-11-05T08:14:00Z"), new Date("2026-11-05T08:20:00Z"), new Date("2026-11-05T09:13:59Z"),
      new Date("2026-11-05T10:13:59Z"), undefined, new Date("2026-11-05T16:13:00Z"), new Date("2026-11-06T05:30:00Z"),
    ], "America/Detroit")).toEqual([
      "Thu, Nov 5, 3:14 AM", undefined, undefined, "Thu 5:13 AM", undefined, "Thu 11:13 AM", "Fri, Nov 6, 12:30 AM",
    ]);
  });

  it("gives no time to a message 59 minutes after the one before it", () => {
    expect(chatTimes([new Date("2026-11-05T08:00:00Z"), new Date("2026-11-05T08:59:00Z")], "America/Detroit"))
      .toEqual(["Thu, Nov 5, 3:00 AM", undefined]);
  });
});
