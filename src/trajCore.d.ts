// Type declarations for trajCore.mjs (the shared trajectory primitives).
import type { Step } from "./types.ts";

export const STDOUT_INLINE_LIMIT: number;

export function genStepId(): string;
export function isoTs(date?: Date): string;
export function rootTrajFile(trajDir: string, trajId: string): string;
export function resolveTrajFile(trajDir: string, trajId: string): string | undefined;

export function appendStep(
  trajFile: string,
  record: Record<string, unknown>,
  opts?: { runStepId?: string; env?: Record<string, string | undefined> }
): string;

export function readSteps(trajFile: string): Step[];

export function newTrajectory(
  trajDir: string,
  opts?: { trajId?: string; fields?: Record<string, unknown> }
): { trajId: string; trajFile: string };
