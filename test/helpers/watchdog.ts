import { createContext, runInContext } from "node:vm";

/**
 * Run `fn` and abort it if it is still running after `ms` milliseconds.
 * A synchronous infinite loop cannot be stopped by a vitest timeout; the vm
 * watchdog terminates it and throws ERR_SCRIPT_EXECUTION_TIMEOUT instead, so
 * a liveness regression fails the test rather than hanging the run.
 */
export function withWatchdog<T>(fn: () => T, ms = 2000): T {
  return runInContext("fn()", createContext({ fn }), { timeout: ms }) as T;
}
