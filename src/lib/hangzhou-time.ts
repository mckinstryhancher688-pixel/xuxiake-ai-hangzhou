/** 杭州半日场景的时间口径；不读取浏览器或服务器的默认时区。 */
export const HANGZHOU_TIME_ZONE = "Asia/Shanghai";
export const HANGZHOU_TIME_LABEL = `杭州时间，${HANGZHOU_TIME_ZONE}`;

const calendarFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HANGZHOU_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: HANGZHOU_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** 用上海日期选取产品假定的出游日，午夜附近也不能沿用 UTC/美西日期。 */
export function hangzhouDateKey(instant: Date): string {
  const parts = calendarFormatter.formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatHangzhouDateTime(value: Date | string): string {
  const instant = typeof value === "string" ? new Date(value) : value;
  const display = Number.isNaN(instant.getTime()) ? String(value) : dateTimeFormatter.format(instant);
  return `${display}（${HANGZHOU_TIME_LABEL}）`;
}
