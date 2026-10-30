// trajectory.ts — typed wrapper over the shared append-only store (trajCore).
//
// The engine appends its machinery steps (shellm-run, prompt, reasoning,
// shell-output, final) through here; the model's bash appends narrative steps
// (observation, thought, idle) through the `traj` shim (bin/traj.mjs), which
// calls the SAME trajCore.appendStep against the SAME file. Both paths honour
// the append protocol in SPEC §2.4.

import {
  appendStep as coreAppend,
  readSteps as coreRead,
  newTrajectory as coreNew,
  rootTrajFile,
  resolveTrajFile,
  genStepId,
  isoTs,
} from "./trajCore.mjs";
import type { Step } from "./types.ts";

export interface Trajectory {
  readonly trajId: string;
  readonly trajDir: string;
  readonly trajFile: string;
  append(record: Record<string, unknown>, opts?: { runStepId?: string }): string;
  read(): Step[];
}

class FileTrajectory implements Trajectory {
  readonly trajId: string;
  readonly trajDir: string;
  readonly trajFile: string;

  constructor(trajId: string, trajDir: string, trajFile: string) {
    this.trajId = trajId;
    this.trajDir = trajDir;
    this.trajFile = trajFile;
  }

  append(record: Record<string, unknown>, opts?: { runStepId?: string }): string {
    return coreAppend(this.trajFile, record, opts ?? {});
  }

  read(): Step[] {
    return coreRead(this.trajFile) as Step[];
  }
}

/** Open an existing root trajectory by id under a trajectory dir. */
export function openTrajectory(trajDir: string, trajId: string): Trajectory {
  return new FileTrajectory(trajId, trajDir, rootTrajFile(trajDir, trajId));
}

/** Open a trajectory whose file is already known (e.g. one `traj new` nested under its parent's directory). */
export function openTrajectoryAt(trajDir: string, trajId: string, trajFile: string): Trajectory {
  return new FileTrajectory(trajId, trajDir, trajFile);
}

/** Create a fresh root trajectory (writes the type:"trajectory" first step). */
export function createTrajectory(
  trajDir: string,
  opts?: { trajId?: string; fields?: Record<string, unknown> }
): Trajectory {
  const { trajId, trajFile } = coreNew(trajDir, opts ?? {});
  return new FileTrajectory(trajId, trajDir, trajFile);
}

export { rootTrajFile, resolveTrajFile, genStepId, isoTs };
