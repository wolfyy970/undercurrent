// stepGuards.ts — the dispatcher's three runaway guards (upstream 2e39a3f, bin/thinkers):
//
//   RewindGuard  THINKERS_REWIND_TOLERANCE  a step stamped older than the newest dispatched step by
//                                           more than the tolerance is a replay of history, not a new
//                                           step (2026-09-12: a script rewrote a 1.5 GB trajectory with
//                                           `grep -v > tmp && mv`; the feed re-read it from line 1 and
//                                           the responder answered month-old Slack threads for 22 hours).
//                                           The comparison is against the dispatcher's own cursor, never
//                                           the clock, so a merely-old message still passes.
//   StuckGuard   THINKERS_STEP_GRACE        a step still alive this long after its run wrote its final
//                THINKERS_STEP_QUIET        is wedged; a step that put nothing on the trajectory for the
//                                           quiet limit is wedged too. TERM, then KILL 15s later, and one
//                                           operator-visible error step per incident.
//
// Pure logic with injected clocks, logs, appends and kills so both are unit-testable; the Dispatcher
// owns the wiring. PORT-NOTE: upstream matches these fields in the RAW step line with bash regexes
// (the LAST `"ts":"…"`, the LAST `"step_id":"…"`); the port reads them from the parsed step. The two
// agree for every step `traj append` writes (ts is the final key and any `"ts":"` inside a string value
// is escaped).

export interface GuardIo {
  /** Dispatcher log line, no indent: `<iso> [dispatcher] <text>`. */
  log(text: string): void;
  /** Append an operator-visible `error` step (source "dispatcher") to a trajectory file. */
  appendError(trajFile: string, reason: string, content: string): void;
}

/** `_iso_epoch`: "YYYY-MM-DDTHH:MM:SS[.fff](Z|+0000)" -> epoch seconds, or null when malformed. */
export function isoEpoch(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  // PORT-NOTE: Date.UTC is the proleptic Gregorian civil-date algorithm bash computes by hand
  // (Hinnant's days_from_civil); same integers for every valid date.
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000);
}

export class RewindGuard {
  private cursor = 0;
  private run = 0;
  private recent: string[] = [];
  private recentSet = new Set<string>();

  private readonly toleranceSecs: number;
  private readonly io: GuardIo;

  // PORT-NOTE: no TS parameter properties — src/ runs under Node's strip-only type stripping.
  constructor(toleranceSecs: number, io: GuardIo) {
    this.toleranceSecs = toleranceSecs;
    this.io = io;
  }

  get enabled(): boolean {
    return this.toleranceSecs > 0;
  }

  /** Seed the cursor from the last line already in a trajectory file, so the very first replayed step is caught. */
  seed(epoch: number | null): void {
    if (this.enabled && epoch !== null && epoch > this.cursor) this.cursor = epoch;
  }

  /** The dispatcher's own appended steps (stuck/rewind/replaced errors) move the cursor and the seen-set like any dispatched step. */
  noteInternal(stepId: string, nowEpoch: number): void {
    if (!this.enabled) return;
    if (nowEpoch > this.cursor) this.cursor = nowEpoch;
    this.remember(stepId);
  }

  private remember(sid: string): void {
    if (!sid) return;
    this.recent.push(sid);
    this.recentSet.add(sid);
    if (this.recent.length > 1000) {
      this.recent = this.recent.slice(-500);
      this.recentSet = new Set(this.recent);
    }
  }

  /** true = dispatch this step; false = a replayed step, skipped. */
  admit(step: { ts?: unknown; step_id?: unknown }, trajFile: string): boolean {
    if (!this.enabled) return true;
    const epoch = isoEpoch(step.ts);
    let why = "";
    let sid = "";
    if (epoch !== null && this.cursor > 0 && epoch < this.cursor - this.toleranceSecs) {
      why = `a step stamped ${this.cursor - epoch}s before the newest dispatched step arrived`;
    } else if (typeof step.step_id === "string" && step.step_id !== "") {
      sid = step.step_id;
      if (this.recentSet.has(sid)) why = `step ${sid} arrived a second time`;
    }
    if (why !== "") {
      if (this.run === 0) {
        this.io.log(
          `REWIND: ${why} from ${trajFile} — the feed restarted from history (trajectory file rewritten or truncated?). Skipping replayed steps; live steps still dispatch.`
        );
        this.io.appendError(
          trajFile,
          "trajectory-rewind",
          `dispatcher: the trajectory feed rewound (${why}). Replayed history is being skipped, not re-dispatched. The trajectory is append-only: never rewrite, copy over, or truncate trajectory.jsonl.`
        );
      }
      this.run++;
      return false;
    }
    if (this.run > 0) {
      this.io.log(`rewind over: skipped ${this.run} replayed step(s)`);
      this.run = 0;
    }
    if (epoch !== null && epoch > this.cursor) this.cursor = epoch;
    this.remember(sid);
    return true;
  }
}

export interface StuckOptions {
  graceSecs: number;
  quietSecs: number;
  /** Monotonic seconds (bash `$SECONDS`). */
  clock: () => number;
  /** `_thinker_busy`. */
  busy: (name: string) => boolean;
  /** pid of the thinker's live step, if known. */
  pidOf: (name: string) => number | undefined;
  /** `_kill_tree`: children first, then the pid. */
  kill: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
  /** The first trajectory file (`head -n 1 run/traj_files`), where a quiet-step error is filed. */
  firstTrajFile: () => string | undefined;
  /** What is still alive in the step's process group (`ps -g`), for the log line; "" = unknown. */
  survivors?: (pid: number) => string;
}

interface Rec {
  name: string;
  at: number;
  /** "-" = the quiet clock (restarted by every step of the run); otherwise the run id of the final clock. */
  rid: string;
  traj: string;
  term: number | null;
}

export class StuckGuard {
  private recs = new Map<string, Rec>();
  private owners: Array<[string, string]> = [];

  private readonly o: StuckOptions;
  private readonly io: GuardIo;

  constructor(o: StuckOptions, io: GuardIo) {
    this.o = o;
    this.io = io;
  }

  /** A step was launched: a fresh quiet clock. */
  noteDispatch(name: string): void {
    this.forget(name);
    this.recs.set(name, { name, at: this.o.clock(), rid: "-", traj: "-", term: null });
  }

  forget(name: string): void {
    this.recs.delete(name);
  }

  /** `_stuck_clock`: only a quiet clock that has not sent TERM is replaced, so a final clock keeps its start. */
  private clock(name: string, rid: string, traj: string): void {
    const cur = this.recs.get(name);
    if (cur && !(cur.rid === "-" && cur.term === null)) return;
    this.recs.delete(name);
    this.recs.set(name, { name, at: this.o.clock(), rid, traj, term: null });
  }

  /** A shellm-run step with launched_by names the thinker that owns the run (only while that thinker is busy). */
  noteRun(stepId: string, launchedBy: string): void {
    if (!stepId || !launchedBy) return;
    if (!this.o.busy(launchedBy)) return;
    this.clock(launchedBy, "-", "-");
    this.owners.push([stepId, launchedBy]);
    if (this.owners.length > 64) this.owners = this.owners.slice(-16);
  }

  /** A step of a run we attributed: any step is progress; a final starts the owner's grace clock. */
  noteStep(type: string, runId: string, trajFile: string): void {
    if (!runId) return;
    let owner = "";
    for (const [id, name] of this.owners) if (id === runId) owner = name;
    if (!owner || !this.o.busy(owner)) return;
    if (type === "final") this.clock(owner, runId, trajFile);
    else this.clock(owner, "-", "-");
  }

  /** `_stuck_step_check` (the housekeeping tick). */
  check(): void {
    const next = new Map<string, Rec>();
    for (const rec of this.recs.values()) {
      if (!this.o.busy(rec.name)) continue; // step ended on its own
      const age = this.o.clock() - rec.at;
      const spid = this.o.pidOf(rec.name);
      const limit = rec.rid === "-" ? this.o.quietSecs : this.o.graceSecs;
      if (rec.term === null) {
        if (limit <= 0 || age < limit) {
          next.set(rec.name, rec);
          continue;
        }
        let traj = rec.traj;
        let why: string;
        let reason: string;
        let advice: string;
        if (rec.rid === "-") {
          traj = this.o.firstTrajFile() ?? "";
          why = `has put nothing on the trajectory for ${age}s`;
          reason = "step-quiet";
          advice =
            "A step that is alive but writes no step is wedged, whatever the cause. If your last block looped or printed without bound, bound it before you run it again.";
        } else {
          why = `is still running ${age}s after its run ${rec.rid} wrote its final`;
          reason = "step-stuck";
          advice =
            "A step that never exits arms no next wake, and the mind goes silent. Usual cause: a process the run left in the background holding the step's output open. Do not background servers or long jobs inside a wake; hand them to a scratch identity or a systemd unit instead.";
        }
        const left = spid !== undefined && this.o.survivors ? this.o.survivors(spid) : "";
        this.io.log(`STUCK: ${rec.name} step (pid ${spid ?? ""}) ${why} — sending TERM. Still alive in its process group: ${left || "none"}`);
        if (traj) this.io.appendError(traj, reason, `dispatcher: the ${rec.name} step (pid ${spid ?? ""}) ${why}, so the dispatcher ended it (TERM). ${advice}`);
        if (spid !== undefined) this.o.kill(spid, "SIGTERM");
        next.set(rec.name, { ...rec, traj, term: this.o.clock() });
      } else if (this.o.clock() - rec.term >= 15) {
        this.io.log(`STUCK: ${rec.name} step (pid ${spid ?? ""}) ignored TERM for 15s — sending KILL`);
        if (spid !== undefined) this.o.kill(spid, "SIGKILL");
        // drop the record; the step's exit reaps the pid on the next tick
      } else {
        next.set(rec.name, rec);
      }
    }
    this.recs = next;
  }
}
