import "@zana-ai/zcc-plugin-sdk/app";
declare module "@zana-ai/zcc-plugin-sdk/app" {
  // Present in the runtime SDK; omitted by the older bundled declarations.
  export function useRpc(): {
    call(method: string, args?: unknown): Promise<unknown>;
  };
  export function useRealtime(event: string, listener: (payload: unknown) => void): void;
}
