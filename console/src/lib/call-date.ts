// Call times are shown in UK time (Europe/London), with BST or GMT so a repeated hour is clear.
const ukZone = "Europe/London";

export const callDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: ukZone, month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export const callDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: ukZone, year: "numeric", month: "2-digit", day: "2-digit",
});
