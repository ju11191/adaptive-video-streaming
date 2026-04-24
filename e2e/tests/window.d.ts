// Shape of the debug handle the player exposes on window (apps/player/src/App.tsx).
export {};

declare global {
  interface Window {
    __avs?: {
      stats: {
        startupMs: number | null;
        segments: { index: number; quality: number; kbps: number; throughputKbps: number }[];
      };
      telemetry: { flush(): Promise<void> };
      arm: string;
      abr: string;
      sid: string;
    };
  }
}
