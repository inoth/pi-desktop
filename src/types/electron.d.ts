export {};

declare global {
  interface Window {
    electron: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, func: (...args: unknown[]) => void) => () => void;
    };
  }
}