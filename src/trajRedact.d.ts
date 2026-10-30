export const TRAJ_VALUE_VARS: string[];
export function trajRedactValues(env?: Record<string, string | undefined>): string[];
export function redactString(s: string, values: string[]): string;
export function redactRecord(x: unknown, values: string[]): unknown;
