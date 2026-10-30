// dispatcher.ts — the resident loop that owns liveness (SPEC §3; bin/thinkers).
//
// In real Headlong the dispatcher `tail -F`s the trajectory file; every appended
// step is an event on a FIFO, matched against each thinker's subscriptions and
// dispatched. Behaviour, not Bash text, is the blueprint (PORT-PLAN §2): the
// FIFO / tail-f / pending-files become an IN-PROCESS event emitter + per-thinker
// queue. The trajectory growing is still the event bus — here, every in-process
// `append` notifies the dispatcher (ObservableTrajectory).
//
// Fidelity note (single load-bearing call): the Bash bus is the FILE, so it also
// carries steps the model's bash appends via the `traj` shim (a subprocess). The
// in-process emitter only sees in-process appends. This is behaviourally
// equivalent for DISPATCH because every shim-appended step is the monolith's own
// (source:"monolith"), which `trigger_self:false` self-skips anyway (§3.2), and a
// shim-appended `share` message is from the identity (responder guards on
// to==identity, so it no-ops). The responder appends in-process, so its
// observation DOES reach the bus and reactively wakes the monolith (§3.3). See
// README "Where slice 2 diverges".
//
// What this owns (SPEC §3.6): subscription match + self-trigger check (§3.2),
// per-thinker FIFO for message/action and last-wins coalescing for everything
// else (§3.6), and the scheduled `wake_at` tick that fires a `monolith-wake`
// (§3.3). The monolith-wake step is NOT appended to the trajectory — it is only
// the trigger payload handed to the thinker (VERIFIED: no monolith-wake step in
// any golden trace; the run header's wake="spontaneous/timer" is the only trace).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Trajectory } from "./trajectory.ts";
import type { Step } from "./types.ts";
import { RewindGuard, StuckGuard, type StuckOptions } from "./stepGuards.ts";
import { LEDGER_TYPES, answeredIds, type WakeLedger } from "./wakeLedger.ts";

const MAX_FIFO = 16; // pending FIFO cap, drop-oldest (bin/thinkers:831)
const FIFO_TYPES = new Set(["message", "action"]); // per-payload; everything else coalesces

// --------------------------------------------------------------------------
// ObservableTrajectory — the in-process event bus (§3.1 #2).
// --------------------------------------------------------------------------

/** The subset of a step the dispatcher routes on. */
export interface TriggerStep {
  type: string;
  source?: string;
  step_id?: string;
  from?: string;
  to?: string;
  content?: string;
  [k: string]: unknown;
}

type AppendListener = (step: TriggerStep) => void;

/**
 * Wraps a Trajectory so every in-process append notifies listeners with the
 * just-appended step (carrying its assigned step_id). Delegates read/append to
 * the inner store — the ONE append-only trajectory both thinkers share.
 */
export class ObservableTrajectory implements Trajectory {
  private readonly inner: Trajectory;
  private readonly listeners: AppendListener[] = [];
  constructor(inner: Trajectory) {
    this.inner = inner;
  }

  get trajId(): string {
    return this.inner.trajId;
  }
  get trajDir(): string {
    return this.inner.trajDir;
  }
  get trajFile(): string {
    return this.inner.trajFile;
  }

  onAppend(fn: AppendListener): void {
    this.listeners.push(fn);
  }

  append(record: Record<string, unknown>, opts?: { runStepId?: string }): string {
    const id = this.inner.append(record, opts);
    const step: TriggerStep = { ...(record as Record<string, unknown>), step_id: id } as TriggerStep;
    for (const l of this.listeners) l(step);
    return id;
  }

  read(): Step[] {
    return this.inner.read();
  }
}

// --------------------------------------------------------------------------
// Subscriptions + thinkers (§3.2).
// --------------------------------------------------------------------------

export interface Subscription {
  types: string[]; // empty = all types
  triggerSelf: boolean; // default false
  watchdogSecs: number; // 0 = off (shipped config: both thinkers 0, §3.7)
  /** Multi-trajectory routing (daemon mode): match only feed() calls for this
   *  file. Undefined = match any trajFile (in-process single-traj mode). */
  trajFile?: string;
}

// --------------------------------------------------------------------------
// PendingStore — the per-thinker backlog when a subscriber is busy (§3.6).
// Two implementations share this interface: MemoryPendingStore (below, the
// Dispatcher default — keeps the in-process tests byte-identical) and
// runstate.ts's FilePendingStore (the daemon's on-disk run/pending/ queue).
// --------------------------------------------------------------------------

export interface PendingEntry {
  key: string;
  name: string;
  type: string;
}

export type PendingPushResult =
  | { kind: "coalesce"; superseded: boolean }
  | { kind: "fifo"; queued: number; dropped: boolean };

export interface PendingStore {
  push(name: string, type: string, step: TriggerStep, kind: "fifo" | "coalesce"): PendingPushResult;
  /** All entries, ordered message-class first, then action-class, then the
   *  rest (coalesced), each class in arrival order — the daemon's firing
   *  order (bin/thinkers `_fire_pending`'s glob passes). */
  list(): PendingEntry[];
  /** Remove and return the step at `key`, or undefined if already taken/gone. */
  take(key: string): TriggerStep | undefined;
  remove(key: string): void;
  /** Drop every entry for `name` (thinker went inactive). */
  clear(name: string): void;
  count(name: string): number;
  hasAny(): boolean;
}

const MAX_PENDING_FIFO = 16; // per (thinker,type) FIFO cap, drop-oldest (bin/thinkers:831)

function splitBucket(bucket: string): [name: string, type: string] {
  const i = bucket.indexOf(".");
  return i === -1 ? [bucket, ""] : [bucket.slice(0, i), bucket.slice(i + 1)];
}

/**
 * In-memory PendingStore. Mirrors FilePendingStore's firing-order contract
 * exactly (message class, then action class, then rest; each class in
 * arrival order) without touching disk — the Dispatcher default, so the
 * existing in-process tests observe identical behaviour whether the backing
 * store is this or the daemon's file-backed one.
 */
export class MemoryPendingStore implements PendingStore {
  private seq = 0;
  private readonly fifo = new Map<string, { key: string; step: TriggerStep }[]>();
  private readonly coalesced = new Map<string, { key: string; step: TriggerStep }>();

  push(name: string, type: string, step: TriggerStep, kind: "fifo" | "coalesce"): PendingPushResult {
    const bucket = `${name}.${type}`;
    if (kind === "coalesce") {
      const superseded = this.coalesced.has(bucket);
      this.coalesced.set(bucket, { key: `${bucket}.coalesced`, step });
      return { kind: "coalesce", superseded };
    }
    const q = this.fifo.get(bucket) ?? [];
    let dropped = false;
    if (q.length >= MAX_PENDING_FIFO) {
      q.shift();
      dropped = true;
    }
    this.seq += 1;
    q.push({ key: `${bucket}.${this.seq}`, step });
    this.fifo.set(bucket, q);
    return { kind: "fifo", queued: q.length, dropped };
  }

  list(): PendingEntry[] {
    const message: PendingEntry[] = [];
    const action: PendingEntry[] = [];
    const rest: PendingEntry[] = [];
    const bucketOf = (type: string) => (type === "message" ? message : type === "action" ? action : rest);
    for (const [bucket, q] of this.fifo) {
      const [name, type] = splitBucket(bucket);
      for (const e of q) bucketOf(type).push({ key: e.key, name, type });
    }
    for (const [bucket, e] of this.coalesced) {
      const [name, type] = splitBucket(bucket);
      bucketOf(type).push({ key: e.key, name, type });
    }
    return [...message, ...action, ...rest];
  }

  take(key: string): TriggerStep | undefined {
    for (const [bucket, q] of this.fifo) {
      const i = q.findIndex((e) => e.key === key);
      if (i !== -1) {
        const [e] = q.splice(i, 1);
        if (q.length === 0) this.fifo.delete(bucket);
        return e!.step;
      }
    }
    for (const [bucket, e] of this.coalesced) {
      if (e.key === key) {
        this.coalesced.delete(bucket);
        return e.step;
      }
    }
    return undefined;
  }

  remove(key: string): void {
    this.take(key);
  }

  clear(name: string): void {
    for (const bucket of [...this.fifo.keys()]) if (bucket.startsWith(`${name}.`)) this.fifo.delete(bucket);
    for (const bucket of [...this.coalesced.keys()]) if (bucket.startsWith(`${name}.`)) this.coalesced.delete(bucket);
  }

  count(name: string): number {
    let n = 0;
    for (const [bucket, q] of this.fifo) if (bucket.startsWith(`${name}.`)) n += q.length;
    for (const bucket of this.coalesced.keys()) if (bucket.startsWith(`${name}.`)) n += 1;
    return n;
  }

  hasAny(): boolean {
    for (const q of this.fifo.values()) if (q.length > 0) return true;
    return this.coalesced.size > 0;
  }
}

export interface ThinkerDef {
  name: string;
  subscription: Subscription;
  /**
   * Run one step; resolves when the run completes (the thinker frees). A number is the step's exit code: non-zero
   * means the wake did not complete, so a ledgered message stays owed (see wakeLedger.ts). `void` = success.
   */
  run(trigger: TriggerStep): Promise<void | number>;
}

export type DispatchEventKind =
  | "dispatch"
  | "pending-queue"
  | "pending-coalesce"
  | "pending-drop"
  | "fire-pending"
  | "skip-self"
  | "skip-inactive"
  | "scheduled-wake";

export interface DispatchEvent {
  kind: DispatchEventKind;
  name: string;
  type?: string;
  source?: string;
  detail?: string;
}

// --------------------------------------------------------------------------
// Dispatcher.
// --------------------------------------------------------------------------

export interface DispatcherOptions {
  /** Directory holding <name>.wake_at files (the monolith's run/ dir). */
  stateDir: string;
  /** IDENTITY_NAME. */
  identityName: string;
  claimTtlMs?: number;
  /** Backlog store; default MemoryPendingStore (in-process). The daemon passes
   *  runstate.ts's FilePendingStore (run/pending/ on disk). */
  pending?: PendingStore;
  /** Membership override (daemon: reads run/active_thinkers, mtime-cached).
   *  Default: the internal Set maintained by register()/setActive(). */
  isActive?: (name: string) => boolean;
  /** Global concurrency cap across all thinkers (bin/thinkers THINKERS_MAX_CONCURRENT). */
  maxConcurrent?: number;
  /** Append a record to a specific trajectory file (daemon: FileTrajectory.append
   *  against the sub_map's file for that thinker). In-process mode falls back to
   *  the ObservableTrajectory passed to the constructor. */
  appendTo?: (trajFile: string, record: Record<string, unknown>) => string;
  /** Text log sink, upstream's "<ISO> [dispatcher] …" format (daemon: run/logs/dispatcher.log). */
  logSink?: (line: string) => void;
  /**
   * Durable receipts for message/action wakes (lost-wake fix; wakeLedger.ts). Absent = upstream behaviour: a wake
   * that is queued or missed while the dispatcher is down is gone. The daemon passes one.
   */
  ledger?: WakeLedger;
  /** THINKERS_CLAIM_STALE_SECS (default 30): age at which a claim/sent receipt is judged orphaned. */
  claimStaleSecs?: number;
  /** THINKERS_TEST_DIE_AFTER_CLAIM fault injection (any set value): SIGKILL this process between the
   *  claim and the launch of a scheduled wake. Test hook only; the daemon passes it through from env. */
  dieAfterClaim?: boolean;
  /** Called instead of process.kill(process.pid, "SIGKILL") when dieAfterClaim fires (unit tests). */
  dieHook?: () => void;
  /**
   * The runaway guards (2e39a3f). Absent = all off (the in-process topology harness). The daemon passes
   * THINKERS_REWIND_TOLERANCE / THINKERS_STEP_GRACE / THINKERS_STEP_QUIET (0 disables each).
   */
  guards?: {
    rewindToleranceSecs: number;
    stepGraceSecs: number;
    stepQuietSecs: number;
    stepPid: (name: string) => number | undefined;
    kill: StuckOptions["kill"];
    firstTrajFile: () => string | undefined;
    clock?: () => number;
    survivors?: StuckOptions["survivors"];
  };
}

const DEFAULT_MAX_CONCURRENT = 20; // THINKERS_MAX_CONCURRENT default

export class Dispatcher {
  private readonly traj: Trajectory | null;
  private readonly opts: DispatcherOptions;
  private readonly pending: PendingStore;
  private readonly maxConcurrent: number;
  private readonly thinkers = new Map<string, ThinkerDef>();
  private readonly active = new Set<string>();
  private readonly busy = new Map<string, Promise<void>>();
  private readonly lastActivity = new Map<string, number>();
  private readonly rewind: RewindGuard | null;
  private readonly stuck: StuckGuard | null;
  /** True while the dispatcher feeds one of its OWN appended steps: those bypass the rewind guard. */
  private internalFeed = false;
  /** Owed (ledgered) steps that did not fit in the 16-deep pending FIFO, per thinker, in arrival order. Never dropped. */
  private readonly overflow = new Map<string, TriggerStep[]>();
  readonly log: DispatchEvent[] = [];

  /**
   * `traj` is the shared in-process bus for the topology test harness
   * (an ObservableTrajectory; hooked via onAppend) or `null` for the daemon,
   * which drives dispatch itself via `feed()` from out-of-process file tails.
   */
  constructor(traj: Trajectory | null, opts: DispatcherOptions) {
    this.traj = traj;
    this.opts = opts;
    this.pending = opts.pending ?? new MemoryPendingStore();
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const g = opts.guards;
    const io = {
      log: (text: string) => this.emitLog(text, false),
      appendError: (trajFile: string, reason: string, content: string) => this.appendOperatorError(trajFile, reason, content),
    };
    this.rewind = g ? new RewindGuard(g.rewindToleranceSecs, io) : null;
    this.stuck = g
      ? new StuckGuard(
          {
            graceSecs: g.stepGraceSecs,
            quietSecs: g.stepQuietSecs,
            clock: g.clock ?? (() => Math.floor(performance.now() / 1000)),
            busy: (n) => this.busy.has(n),
            pidOf: g.stepPid,
            kill: g.kill,
            firstTrajFile: g.firstTrajFile,
            ...(g.survivors ? { survivors: g.survivors } : {}),
          },
          io
        )
      : null;
    if (traj instanceof ObservableTrajectory) {
      traj.onAppend((s) => this.feed(s, traj.trajFile));
    }
  }

  /** Seed the rewind cursor from the last step already in a trajectory file (see RewindGuard.seed). */
  seedRewindCursor(epoch: number | null): void {
    this.rewind?.seed(epoch);
  }

  /**
   * `_append_traj_error`: an operator-visible error step (same shape as the monolith's run-failed
   * step) in a trajectory file. Failure-open: never blocks dispatch. The dispatcher's own steps move
   * the rewind cursor and the seen-set like any dispatched step and are not themselves screened.
   */
  appendOperatorError(trajFile: string, reason: string, content: string): void {
    try {
      this.internalFeed = true;
      this.appendRecord(trajFile, { type: "error", source: "dispatcher", reason, content });
    } catch {
      /* failure-open */
    } finally {
      this.internalFeed = false;
    }
  }

  register(def: ThinkerDef): void {
    this.thinkers.set(def.name, def);
    this.active.add(def.name);
  }

  /** Explicit membership control for tests/daemon paths not using the default Set. */
  setActive(name: string, on: boolean): void {
    if (on) this.active.add(name);
    else this.active.delete(name);
  }

  private isActiveName(name: string): boolean {
    return this.opts.isActive ? this.opts.isActive(name) : this.active.has(name);
  }

  /** upstream's dispatcher.log text: `[dispatcher] <text>` for a top-level
   *  event (`indent:false` — "step: type=…", "ownership lost…"), or
   *  `[dispatcher]   <text>` (3-space indent) for a sub-event nested under
   *  the step that caused it ("dispatch ->", "pending ->", "skip …", …). */
  private emitLog(text: string, indent = true): void {
    if (!this.opts.logSink) return;
    const gap = indent ? "   " : " ";
    this.opts.logSink(`${new Date().toISOString()} [dispatcher]${gap}${text}`);
  }

  /** Append an external step (e.g. an inbound chat message) onto the bus. */
  inject(record: Record<string, unknown>): string {
    if (!this.traj) throw new Error("Dispatcher.inject() requires an in-process trajectory");
    return this.traj.append(record);
  }

  /**
   * Fire a manual-trigger for a thinker (`thinkers trigger`, §3.8). Delivered
   * like a manual-trigger pending file — bypasses subscription matching — so the
   * boot kick fires the thinker once regardless of its `types`. NOT appended to
   * the trajectory (it is a pending-file, not a narrative step). Carries NO
   * content, matching upstream's boot-kick payload (bin/thinkers:1173-1174).
   */
  bootTrigger(name: string, source = "thinkers-cli", trajFile?: string): void {
    if (!this.thinkers.has(name) || !this.isActiveName(name) || this.busy.has(name)) return;
    const active = this.busy.size;
    this.log.push({ kind: "fire-pending", name, type: "manual-trigger" });
    this.dispatch(name, { type: "manual-trigger", source }, trajFile, `fire pending -> ${name} (type=manual-trigger, active=${active})`);
  }

  /**
   * feed() is the out-of-process entry point (daemon: one call per complete
   * trajectory.jsonl line from a TrajFeeder) AND the in-process bus handler
   * (hooked to ObservableTrajectory.onAppend above) — same routing either way
   * (bin/thinkers:760-897). `trajFile`, when given, is matched against a
   * subscription's `trajFile` (undefined subscription = matches any file).
   */
  feed(step: TriggerStep, trajFile?: string, fopts: { replay?: boolean } = {}): void {
    const replay = fopts.replay === true;
    // A step read back from the cursor gap (appended while no dispatcher ran): only the ledgered types are owed;
    // everything else keeps upstream's rule that a restart does not replay it. The rewind guard is for a file that
    // was rewritten under a live feeder, not for this deliberate catch-up, so it does not screen replays.
    if (replay && !(this.opts.ledger && LEDGER_TYPES.has(String(step.type ?? "")))) return;
    // Rewind guard (2e39a3f): a replayed step is skipped before any dispatch work.
    if (!replay && this.rewind && !this.internalFeed && !this.rewind.admit(step as { ts?: unknown; step_id?: unknown }, trajFile ?? "")) return;
    // _fire_pending first so a step flagged while its thinker was busy is
    // delivered before this newer step (bin/thinkers:761-763).
    this.firePending();

    const type = String(step.type ?? "");
    const source = step.source === undefined ? "" : String(step.source);
    if (!type) return;
    this.emitLog(`step: type=${type} source=${source || "-"}`, false);
    if (this.stuck) {
      if (type === "shellm-run") this.stuck.noteRun(strField(step.step_id), strField(step["launched_by"]));
      else this.stuck.noteStep(type, strField(step["run_id"]), trajFile ?? "");
    }

    for (const def of this.thinkers.values()) {
      const sub = def.subscription;

      if (sub.trajFile !== undefined && trajFile !== undefined && sub.trajFile !== trajFile) continue;

      // type match (empty means all) (bin/thinkers:780-790).
      if (sub.types.length > 0 && !sub.types.includes(type)) continue;

      // self-trigger check (bin/thinkers:792-809). Own error/log_error never
      // self-fire even with trigger_self (would loop).
      if (source === def.name) {
        if (!sub.triggerSelf) {
          this.log.push({ kind: "skip-self", name: def.name, type });
          this.emitLog(`skip ${def.name} (self-trigger)`);
          continue;
        }
        if (type === "error" || type === "log_error") {
          this.emitLog(`skip ${def.name} (self error — would loop)`);
          continue;
        }
      }

      // active check (bin/thinkers:811-814) — silent, matching upstream (no log line).
      if (!this.isActiveName(def.name)) {
        this.log.push({ kind: "skip-inactive", name: def.name, type });
        continue;
      }

      // Lost-wake fix: a message/action is owed to this thinker from here on. Ledger it BEFORE anything else can fail
      // (and before the feeder cursor passes it); a step it already knows (replay overlap) is not owed twice.
      const ledger = this.opts.ledger;
      const stepId = strField(step.step_id);
      let owedNow = false;
      if (ledger && stepId && LEDGER_TYPES.has(type)) {
        if (!ledger.recv(def.name, stepId, trajFile ?? "", step as Record<string, unknown>)) continue;
        owedNow = true;
      }

      // per-thinker concurrency while busy (bin/thinkers:824-882).
      if (owedNow && ((this.overflow.get(def.name)?.length ?? 0) > 0 || (this.busy.has(def.name) && this.pending.count(def.name) >= MAX_PENDING_FIFO))) {
        // The pending FIFO is full (it would drop its oldest): an owed step is never dropped. Keep order behind it.
        this.pushOverflow(def.name, step);
        continue;
      }
      if (this.busy.has(def.name)) {
        if (FIFO_TYPES.has(type)) {
          // PORT-NOTE (sync 2e39a3f, 47b3aa1 salience feedback removal): a message that queues behind a
          // busy run used to ALSO be appended as a `feedback` step so the run could answer inline.
          // Upstream removed that path (dead since the monolith moved to run scope: run scope keeps only
          // rows with the run's id, and the step had none); the responder answers every message at once
          // and a deferral hands real work to the mind as an `action`. The pending file is the whole handoff.
          this.enqueueFifo(def.name, type, step);
        } else {
          this.coalesce(def.name, type, step);
        }
        continue;
      }

      // dispatch (bin/thinkers:884-896). `active` is the busy count BEFORE
      // this dispatch, matching bash's `_count_active_steps` read just before
      // the printf (the concurrency-cap busy-wait, if any, has already settled).
      const activeBefore = this.busy.size;
      this.dispatch(def.name, step, trajFile, `dispatch -> ${def.name} (active=${activeBefore})`);
    }
  }

  private enqueueFifo(name: string, type: string, step: TriggerStep): void {
    const r = this.pending.push(name, type, step, "fifo");
    const queued = r.kind === "fifo" ? r.queued : 0;
    if (r.kind === "fifo" && r.dropped) {
      this.log.push({ kind: "pending-drop", name, type });
      this.emitLog(`pending ${name}.${type} queue full — dropping oldest`);
    }
    this.log.push({ kind: "pending-queue", name, type, detail: `queued=${queued}` });
    this.emitLog(`pending -> ${name} (type=${type}, queued=${queued})`);
  }

  private coalesce(name: string, type: string, step: TriggerStep): void {
    const r = this.pending.push(name, type, step, "coalesce"); // last-wins (bin/thinkers:872-878)
    this.log.push({ kind: "pending-coalesce", name, type });
    if (r.kind === "coalesce" && r.superseded) {
      this.emitLog(`pending ${name}.${type} superseded (last-wins)`);
    }
    this.emitLog(`pending -> ${name} (type=${type}, coalesced)`);
  }

  /**
   * Append a record to `trajFile` AND deliver it through this dispatcher's
   * own feed() synchronously — matching the in-process ObservableTrajectory
   * path (`.append()` notifies listeners immediately) and upstream's own
   * tight causality (a step appended to an ALREADY-tailed trajectory is
   * picked up by the same `tail -F` pipe within the same read-loop pass, not
   * on a later tick). Without this, the daemon's out-of-process feeder would
   * only notice the appended line on its next poll/watch tick — ~1s late,
   * and out of order relative to anything else happening synchronously right
   * now (e.g. a busy thinker's step finishing and re-firing its own pending
   * queue). `opts.appendTo`'s caller (daemon.ts) resyncs the matching
   * feeder's offset past these bytes so it is never delivered twice.
   */
  private appendRecord(trajFile: string | undefined, record: Record<string, unknown>): void {
    if (this.opts.appendTo && trajFile !== undefined) {
      const stepId = this.opts.appendTo(trajFile, record);
      this.rewind?.noteInternal(stepId, Math.floor(Date.now() / 1000));
      const was = this.internalFeed;
      this.internalFeed = true; // the dispatcher's own step: not screened as a replay
      try {
        this.feed({ ...(record as TriggerStep), step_id: stepId }, trajFile);
      } finally {
        this.internalFeed = was;
      }
      return;
    }
    if (this.traj) this.traj.append(record); // ObservableTrajectory already notifies via onAppend
  }

  /**
   * Set busy synchronously, then run on a microtask so the caller fully
   * returns (all subscriptions processed) before the run begins appending.
   * `logText`, when given, is the ONE dispatcher.log line this dispatch
   * writes — upstream's `_dispatch_step` itself is silent; every caller
   * (the reactive sub_map match, `_fire_pending`, the watchdog, a scheduled
   * wake) prints its own single caller-specific line before calling it, and
   * no dispatch is ever logged twice.
   */
  private dispatch(name: string, step: TriggerStep, trajFile: string | undefined, logText?: string): void {
    const def = this.thinkers.get(name);
    if (!def) return;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    this.busy.set(name, done);
    this.stuck?.noteDispatch(name);
    this.lastActivity.set(name, Math.floor(Date.now() / 1000));
    this.log.push({
      kind: "dispatch",
      name,
      type: String(step.type ?? ""),
      ...(step.source !== undefined ? { source: String(step.source) } : {}),
    });
    if (logText !== undefined) this.emitLog(logText);
    queueMicrotask(() => {
      let ok = true;
      void def
        .run(step)
        .then((r) => {
          if (typeof r === "number" && r !== 0) ok = false;
        })
        .catch(() => {
          /* thinker errors are surfaced as steps by the thinker itself */
          ok = false;
        })
        .finally(() => {
          // The CONSUMED receipt: the thinker's step for this message ran to completion.
          const lid = strField(step.step_id);
          const ledger = this.opts.ledger;
          if (ledger && lid && ledger.isOwed(name, lid)) {
            if (ok) ledger.done(name, lid);
            else this.emitLog(`step for ${lid} failed — it stays owed to ${name} and is retried at the next dispatcher start`);
          }
          this.busy.delete(name);
          this.stuck?.forget(name);
          this.lastActivity.set(name, Math.floor(Date.now() / 1000));
          resolveDone();
          this.firePending();
        });
    });
    void trajFile; // reserved: per-thinker trajFile is carried by the subscription, not the call site
  }

  /**
   * _fire_pending (bin/thinkers:616-642): dispatch queued steps in GLOBAL
   * firing order (message class, then action class, then the rest) across
   * ALL thinkers — not per-thinker — stopping at the concurrency cap. An
   * inactive thinker's whole backlog is dropped, not fired.
   */
  private firePending(): void {
    this.topUp();
    for (const entry of this.pending.list()) {
      if (this.busy.size >= this.maxConcurrent) return;
      if (this.busy.has(entry.name)) continue;
      if (!this.isActiveName(entry.name)) {
        this.pending.clear(entry.name);
        continue;
      }
      const step = this.pending.take(entry.key);
      if (!step) continue;
      const active = this.busy.size;
      this.log.push({ kind: "fire-pending", name: entry.name, type: entry.type });
      this.dispatch(entry.name, step, undefined, `fire pending -> ${entry.name} (type=${entry.type}, active=${active})`);
    }
  }

  private pushOverflow(name: string, step: TriggerStep): void {
    let q = this.overflow.get(name);
    if (!q) this.overflow.set(name, (q = []));
    q.push(step);
    this.emitLog(`pending -> ${name} (type=${String(step.type ?? "")}, overflow=${q.length}; owed, not dropped)`);
  }

  /** Move overflowed owed steps into the pending FIFO while it has room, oldest first. */
  private topUp(): void {
    for (const [name, q] of this.overflow) {
      while (q.length > 0 && this.pending.count(name) < MAX_PENDING_FIFO - 1) {
        const step = q.shift()!;
        this.pending.push(name, String(step.type ?? ""), step, "fifo");
      }
      if (q.length === 0) this.overflow.delete(name);
    }
  }

  /**
   * Boot-time catch-up (lost-wake fix): re-queue every step the ledger still owes. A step the trajectory already
   * answers (the thinker finished but the dispatcher died before it wrote the receipt) is marked consumed instead
   * of being run again; a thinker that is switched off or gone is released. Returns what it did, for the log.
   */
  replayOwed(trajFileOf: (name: string) => string | undefined): { requeued: number; answered: number; released: number } {
    const out = { requeued: 0, answered: 0, released: 0 };
    const ledger = this.opts.ledger;
    if (!ledger) return out;
    for (const name of ledger.owedThinkers()) {
      const entries = ledger.unconsumed(name);
      if (!this.thinkers.has(name) || !this.isActiveName(name)) {
        for (const e of entries) ledger.done(name, e.id, "thinker-inactive");
        out.released += entries.length;
        continue;
      }
      const files = new Set(entries.map((e) => e.file || trajFileOf(name) || ""));
      const answered = new Set<string>();
      for (const f of files) {
        if (!f) continue;
        const ids = new Set(entries.filter((e) => (e.file || trajFileOf(name) || "") === f).map((e) => e.id));
        for (const id of answeredIds(f, name, ids)) answered.add(id);
      }
      for (const e of entries) {
        if (answered.has(e.id)) {
          ledger.done(name, e.id, "answered-in-trajectory");
          out.answered++;
          continue;
        }
        out.requeued++;
        this.pushOverflow(name, { ...(e.step as TriggerStep), step_id: e.id });
      }
    }
    this.firePending();
    return out;
  }

  // ---- housekeeping tick (bin/thinkers:683-701) ----

  /** Fire pending re-triggers, check watchdogs, then check scheduled wakes for `nowEpoch` (s). */
  tick(nowEpoch: number): void {
    this.firePending();
    this.watchdogCheck(nowEpoch);
    this.stuck?.check();
    this.scheduledWakeCheck(nowEpoch);
  }

  /**
   * _watchdog_check: a `trigger_self:true` thinker that has been idle (not
   * busy, nothing pending) for its whole `watchdog_secs` window gets a
   * synthetic `{type:"idle",source:<name>,synthetic:"watchdog"}` nudge so it
   * never goes permanently silent. Off (watchdogSecs<=0, or not trigger_self)
   * for both shipped thinkers — a no-op in the current topology.
   */
  watchdogCheck(nowEpoch: number): void {
    for (const def of this.thinkers.values()) {
      const sub = def.subscription;
      if (!sub.triggerSelf || sub.watchdogSecs <= 0) continue;
      if (!this.isActiveName(def.name)) continue;
      if (this.busy.has(def.name) || this.pending.count(def.name) > 0) {
        this.lastActivity.set(def.name, nowEpoch);
        continue;
      }
      const last = this.lastActivity.get(def.name) ?? nowEpoch;
      if (nowEpoch - last < sub.watchdogSecs) continue;
      const quiet = nowEpoch - last;
      this.lastActivity.set(def.name, nowEpoch);
      this.dispatch(
        def.name,
        { type: "idle", content: "idle", source: def.name, synthetic: "watchdog" },
        undefined,
        `watchdog -> ${def.name} (quiet ${quiet}s)`
      );
    }
  }

  /**
   * _scheduled_wake_check (bin/thinkers:661-681): a thinker asks to be re-fired by
   * writing a target epoch to run/<name>.wake_at. When due and the thinker is
   * active + not busy, fire it with a synthetic monolith-wake step (source
   * "monolith-timer") and consume the file. The step is NOT appended to the traj.
   *
   * PORT-NOTE (bin/thinkers:664, `for _wf in "$run_dir"/*.wake_at`): upstream
   * globs run/ on DISK, so an orphaned `<name>.wake_at` for a name with no
   * registered thinker is still visited and removed (`grep -qx "$_wname"
   * active_thinkers` fails -> `rm -f`). Iterating `this.thinkers.keys()`
   * instead would skip those files forever, since an unregistered name never
   * appears there — glob the dir, same as upstream, so isActiveName's
   * false-for-unregistered path (matching the grep failing) still prunes them.
   */
  private scheduledWakeCheck(nowEpoch: number): void {
    this.sweepClaims(nowEpoch);
    let entries: string[];
    try {
      entries = fs.readdirSync(this.opts.stateDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".wake_at")) continue;
      const name = entry.slice(0, -".wake_at".length);
      const wf = path.join(this.opts.stateDir, entry);
      let raw: string;
      try {
        raw = fs.readFileSync(wf, "utf8").trim();
      } catch {
        continue;
      }
      if (!/^[0-9]+$/.test(raw)) {
        rmQuiet(wf);
        continue;
      }
      if (!this.isActiveName(name)) {
        rmQuiet(wf);
        continue;
      }
      if (nowEpoch < Number(raw)) continue;
      if (this.busy.has(name)) continue; // retry next tick; the step re-arms on its way out
      if (this.busy.size >= this.maxConcurrent) continue;
      // Atomic claim: rename is the mutex (bash `mv "$_wf" "$_claim"`). A claim receipt lives from
      // the claim until the step is launched, so a crash in that window leaves evidence instead of
      // swallowing the send. utimes resets the clock: rename keeps the wake file's own write time,
      // which can be hours old for a wake armed in advance.
      const claim = path.join(this.opts.stateDir, "claimed", name);
      const sent = path.join(this.opts.stateDir, "sent", name);
      try {
        fs.mkdirSync(path.dirname(claim), { recursive: true });
        fs.renameSync(wf, claim);
      } catch {
        continue; // another owner won the claim
      }
      touch(claim);
      if (this.opts.dieAfterClaim) {
        // Fault injection (THINKERS_TEST_DIE_AFTER_CLAIM): die between the claim and the launch.
        (this.opts.dieHook ?? (() => process.kill(process.pid, "SIGKILL")))();
        return;
      }
      // Sent receipt: renamed across atomically just before the launch. From here the send belongs
      // to this dispatcher and the sweep never re-arms a sent receipt, so a crash after the launch
      // cannot send the same wake twice (at-least-once before the rename, at-most-once after).
      try {
        fs.mkdirSync(path.dirname(sent), { recursive: true });
        fs.renameSync(claim, sent);
      } catch {
        continue;
      }
      touch(sent);
      const due = nowEpoch - Number(raw);
      this.log.push({ kind: "scheduled-wake", name, detail: `due ${due}s ago` });
      this.dispatch(
        name,
        { type: "monolith-wake", content: "wake", source: "monolith-timer" },
        undefined,
        `scheduled wake -> ${name} (due ${due}s ago)`
      );
      rmQuiet(sent);
    }
  }

  /**
   * `_sweep_claims` (bin/thinkers, 2e39a3f). Crash recovery for claim receipts: claimed/<name> exists
   * only between the claim and the launch of its step, so one older than THINKERS_CLAIM_STALE_SECS
   * means the dispatcher died in that window. Re-arm it as a due wake (at-least-once: a rare repeat
   * beats a post that never goes out) — unless the name already has a live wake_at, which wins (the
   * claim's own due time is already past, so re-arming with it would only fire the live occurrence
   * early). A sent receipt that outlived its step is a crash after the launch: the send already
   * happened, so the evidence is dropped, never re-armed (re-arming is exactly the double fire).
   */
  private sweepClaims(nowEpoch: number): void {
    const stale = this.opts.claimStaleSecs ?? 30;
    const dir = this.opts.stateDir;
    for (const f of listFiles(path.join(dir, "claimed"))) {
      const age = nowEpoch - mtimeSecs(f);
      if (age < stale) continue;
      const base = path.basename(f);
      const wa = path.join(dir, `${base}.wake_at`);
      if (fs.existsSync(wa)) {
        const ct = readTrim(f);
        const wt = readTrim(wa);
        if (/^[0-9]+$/.test(wt)) {
          this.emitLog(`dropped stale claim ${base}, kept scheduled wake_at ${wt}`);
        } else if (/^[0-9]+$/.test(ct)) {
          try {
            fs.writeFileSync(wa, ct);
          } catch {
            /* best effort, like `|| true` */
          }
          this.emitLog(`re-armed stale claim ${base} (age ${age}s)`);
        } else {
          this.emitLog(`dropped stale claim ${base} (unreadable due time), left the existing wake_at alone`);
        }
        rmQuiet(f);
      } else {
        try {
          fs.renameSync(f, wa);
        } catch {
          rmQuiet(f);
        }
        this.emitLog(`re-armed stale claim ${base} (age ${age}s)`);
      }
    }
    for (const f of listFiles(path.join(dir, "sent"))) {
      const age = nowEpoch - mtimeSecs(f);
      if (age < stale) continue;
      rmQuiet(f);
      this.emitLog(`dropped stale sent receipt ${path.basename(f)} (age ${age}s)`);
    }
  }

  // ---- test-facing drivers ----

  /** True while any thinker is running or has queued/coalesced pending work. */
  isIdle(): boolean {
    return this.busy.size === 0 && !this.pending.hasAny();
  }

  /**
   * Settle all in-flight cascades: run every dispatched thinker to completion,
   * draining FIFO/coalesced pending as thinkers free. Does NOT fire scheduled
   * wakes — call tick() for those, so a test controls timer wakes separately from
   * reactive cascades. `maxRounds` guards against a runaway loop.
   */
  async settle(maxRounds = 1000): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await new Promise<void>((r) => setImmediate(r)); // flush microtasks
      this.firePending();
      if (this.busy.size > 0) {
        await Promise.allSettled([...this.busy.values()]);
        continue;
      }
      if (this.pending.hasAny()) continue; // firePending on next round dispatches it
      return;
    }
    throw new Error("dispatcher.settle: did not reach idle within maxRounds");
  }
}

function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

function touch(p: string): void {
  try {
    const now = new Date();
    fs.utimesSync(p, now, now);
  } catch {
    /* best effort */
  }
}

function listFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* raced away */
    }
  }
  return out;
}

function mtimeSecs(p: string): number {
  try {
    return Math.floor(fs.statSync(p).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

function readTrim(p: string): string {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function strField(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
