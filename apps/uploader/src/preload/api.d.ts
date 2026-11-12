import type { UploaderApi } from "../shared/types";

declare global {
  interface Window {
    uploader: UploaderApi & { designLatest(designId: string): Promise<number | null> };
  }
}

export {};
