// The project has no @types/node. Tests that need a watchdog declare just the
// one Node API they use.
declare module "node:vm" {
  export function createContext(sandbox: object): object;
  export function runInContext(code: string, context: object, options?: { timeout?: number }): unknown;
}

declare function setTimeout(handler: (value: unknown) => void, ms?: number): unknown;
