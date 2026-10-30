// wakeSections.ts — the wake-prompt sections the monolith builds from the sent
// ledger (upstream sync 2e39a3f: thinkers/_lib/common.sh `_outbound_section` and
// `_schedule_signals`; design/outbound_delivery.md part 5, design/scheduled_goals.md).
//
// PORT-NOTE: upstream shells out to `chat sent --json` and `date`; this port runs in
// the trajectory's own process, so it calls the chat module's `sentRowsForTrajectory`
// (the rows `chat sent --json` prints) and formats clock times with Intl. The jq
// programs are transcribed field for field, including jq's own truthiness: `//`
// treats only null and false as absent, so an empty-string filename still wins over
// the content (`.filename // .content // ""`).

import * as fs from "node:fs";
import * as path from "node:path";
import { sentRowsForTrajectory } from "./chat.ts";

type Row = Record<string, unknown>;

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== false;
const jqStr = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "null" : String(v));
/** jq string slice `[a:b]` counts codepoints. */
const cps = (s: string, a: number, b: number): string => Array.from(s).slice(a, b).join("");
const envInt = (v: string | undefined, d: number): number => (v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : d);

function ageText(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function outboundLine(r: Row): string {
  const state = r["state"];
  let what: string;
  if (state === "delivered") what = "delivered";
  else if (state === "failed") what = `FAILED, never arrived (${jqStr(present(r["reason"]) ? r["reason"] : "no reason given")})`;
  else if (state === "skipped") what = `not sent (${jqStr(present(r["reason"]) ? r["reason"] : "skipped")})`;
  else if (state === "pending")
    what = Number(r["age_s"]) > 300 ? `PENDING ${ageText(Number(r["age_s"]))}, no delivery confirmation yet (the bridge may be down)` : "pending";
  else what = "sent (this transport does not confirm delivery)";
  const tsRaw = present(r["ts"]) ? jqStr(r["ts"]) : "?";
  const when = cps(tsRaw, 0, 16).replace("T", " ");
  const body = jqStr(present(r["filename"]) ? r["filename"] : present(r["content"]) ? r["content"] : "").replace(/\n/g, " ");
  const shown = Array.from(body).length > 70 ? cps(body, 0, 70) + "…" : body;
  return `- ${when}Z to ${jqStr(r["to"])}: ${what}${present(r["key"]) ? ` [${jqStr(r["key"])}]` : ""} "${shown}"`;
}

/**
 * `_outbound_section`: what the identity said outward in the last OUTBOUND_SINCE (24h),
 * newest first, with what the bridge reported back. "" = no section. Throws when
 * `chat sent` would fail (the caller leaves the section out).
 */
export function outboundSection(
  trajFile: string,
  me: string,
  env: NodeJS.ProcessEnv,
  now: () => number,
): string {
  const since = env["OUTBOUND_SINCE"] || "24h";
  const max = envInt(env["OUTBOUND_MAX"] || undefined, 10);
  const rows = sentRowsForTrajectory(trajFile, me, since, 200, now);
  if (rows.length === 0) return "";
  const lines = [
    `Sent in the last ${since} (newest first; \`chat sent\` shows more; a FAILED line means the message never reached anyone, fix the address and send again; do not send again anything listed as delivered or pending):`,
    ...rows.slice(0, max).map(outboundLine),
  ];
  if (rows.length > max) lines.push(`- and ${rows.length - max} more: \`chat sent --since ${since}\``);
  return lines.join("\n");
}

// --- scheduled goals ---------------------------------------------------------

interface ZoneClock {
  weekday: string;
  day: string; // YYYY-MM-DD
  hm: string; // HH:MM
  zone: string; // %Z
}

/** `TZ=<tz> date`'s weekday, date, time and zone abbreviation; an unknown zone reads as UTC. */
function zoneClock(ms: number, tz: string): ZoneClock {
  const mk = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
  let parts;
  try {
    parts = mk(tz);
  } catch {
    parts = mk("UTC");
  }
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return {
    weekday: g("weekday"),
    day: `${g("year")}-${g("month")}-${g("day")}`,
    hm: `${g("hour")}:${g("minute")}`,
    zone: g("timeZoneName"),
  };
}

/** `_fm <file> <key>`: every `key: value` line of the front matter, joined as `$(...)` would. */
function frontMatter(text: string, key: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") return "";
  const k = `${key}: `;
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === "---") break;
    if (l.startsWith(k)) out.push(l.slice(k.length));
  }
  return out.join("\n").replace(/\n+$/, "");
}

function utcClock(ms: number): { day: string; hmz: string } {
  const iso = new Date(ms).toISOString();
  return { day: iso.slice(0, 10), hmz: `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` };
}

/** `${t%:*}` / `${t#*:}` then `10#` arithmetic; NaN when bash arithmetic would reject it. */
function minutesOfDay(t: string): number {
  const c = t.indexOf(":");
  const hh = c < 0 ? t : t.slice(0, t.lastIndexOf(":"));
  const mm = c < 0 ? t : t.slice(c + 1);
  if (!/^[0-9]+$/.test(hh) || !/^[0-9]+$/.test(mm)) return NaN;
  return Number(hh) * 60 + Number(mm);
}

/**
 * `_schedule_signals`: the clock line plus one routing signal per scheduled goal. A goal
 * memory with `schedule: 09:00 17:00` has one window per time per day; whether a window is
 * due, done or ahead is worked out here, not by the model. Returns "" never: the Now line is
 * always present (the caller prepends it to the routing signals).
 */
export function scheduleSignals(
  memDir: string,
  trajFile: string,
  me: string,
  env: NodeJS.ProcessEnv,
  now: () => number,
): string {
  const tz = env["HEADLONG_TZ"] || "UTC";
  const grace = envInt(env["SCHEDULE_GRACE_MIN"] || undefined, 360);
  const ms = now();
  const nowLine = zoneClock(ms, tz);
  // `date -u +'%Y-%m-%d %H:%MZ'` is the parenthesised half.
  const out: string[] = [`- Now: ${nowLine.weekday} ${nowLine.day} ${nowLine.hm} ${nowLine.zone} (${utcClock(ms).hmz}).`];
  if (!fs.existsSync(memDir) || !fs.statSync(memDir).isDirectory()) return out.join("\n");

  let sent: Array<{ key: string; at: string }> = [];
  try {
    sent = sentRowsForTrajectory(trajFile, me, "2d", 500, now)
      .filter((r) => present(r["key"]) && r["state"] !== "failed" && r["state"] !== "skipped")
      .map((r) => ({ key: jqStr(r["key"]), at: `${cps(jqStr(r["ts"]), 11, 16)}Z` }));
  } catch {
    sent = [];
  }
  const sentAt = (key: string): string => {
    let v = "";
    for (const s of sent) if (s.key === key) v = s.at;
    return v;
  };

  const files = fs
    .readdirSync(memDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(memDir, f));
  const today = utcClock(ms).day;
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!text.split("\n").some((l) => l.startsWith("schedule:"))) continue; // grep -l '^schedule:'
    const sched = frontMatter(text, "schedule");
    const until = frontMatter(text, "until");
    if (sched === "" || (until !== "" && until < today)) continue;
    const gtz = frontMatter(text, "tz") || tz;
    const id = frontMatter(text, "id");
    const title = frontMatter(text, "summary")
      .split("\n")
      .map((l) => Array.from(l).slice(0, 60).join(""))
      .join("\n");
    const clock = zoneClock(ms, gtz);
    const nowM = minutesOfDay(clock.hm);
    let due = "";
    let next = "";
    let said = "";
    const times = sched.split(/\s+/).filter(Boolean);
    for (const t of times) {
      const tM = minutesOfDay(t);
      if (Number.isNaN(tM)) continue;
      const key = `${id}/${clock.day}-${t.replace(":", "")}`;
      const at = sentAt(key);
      if (tM > nowM) {
        if (next === "") next = `${t} ${clock.zone}, in ${Math.floor((tM - nowM) / 60)}h${(tM - nowM) % 60}m`;
      } else if (at !== "") {
        said += `the ${t} window was sent at ${at}; `;
        due = "";
      } else if (nowM - tM <= grace) {
        due = `${t} ${key}`;
      } else {
        said += `the ${t} window was missed, let it go; `;
      }
    }
    if (due !== "") {
      const sp = due.indexOf(" ");
      out.push(
        `- DUE NOW: "${title}", the ${due.slice(0, sp)} ${clock.zone} window of ${clock.day}. Send it once, this wake, with: chat send --to <name> --key ${due.slice(sp + 1)} <<"MSG" (the message on stdin as a quoted heredoc). The key marks this window done; a second send with it is refused.`,
      );
    } else {
      out.push(
        `- Scheduled "${title}": ${said}next window ${next || `tomorrow at ${sched.split(" ")[0]} ${clock.zone}`}. Nothing to send for this goal before then.`,
      );
    }
  }
  return out.join("\n");
}
