const TIME_ZONE = "Asia/Taipei";

export class SiteBuildingWindowError extends Error {
  constructor(message) {
    super(message);
    this.name = "SiteBuildingWindowError";
  }
}

function taipeiMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

export function getSiteBuildingWindow(date = new Date()) {
  const minutes = taipeiMinutes(date);
  const inMorningPeak = minutes >= 9 * 60 && minutes < 12 * 60;
  const beforeMorningPeak = minutes >= 8 * 60 && minutes < 9 * 60;
  const inAfternoonPeak = minutes >= 14 * 60 && minutes < 18 * 60;
  const beforeAfternoonPeak = minutes >= 13 * 60 && minutes < 14 * 60;

  if (inMorningPeak || inAfternoonPeak) {
    return {
      allowed: false,
      reason: "DeepSeek peak pricing is active",
      timeZone: TIME_ZONE,
    };
  }
  if (beforeMorningPeak || beforeAfternoonPeak) {
    return {
      allowed: false,
      reason: "DeepSeek peak pricing begins within 60 minutes",
      timeZone: TIME_ZONE,
    };
  }
  return { allowed: true, reason: null, timeZone: TIME_ZONE };
}

export function assertSiteBuildingWindow(date = new Date()) {
  const window = getSiteBuildingWindow(date);
  if (!window.allowed) {
    throw new SiteBuildingWindowError(`${window.reason} (${TIME_ZONE})`);
  }
  return window;
}
