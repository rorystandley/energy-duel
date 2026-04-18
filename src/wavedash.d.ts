declare const WavedashJS:
  | {
      init(options?: Record<string, unknown>): Promise<void>;
      readyForEvents(): void;
    }
  | undefined;
