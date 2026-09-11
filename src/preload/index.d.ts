import type { CockpitApi } from "./index";

declare global {
  const __APP_VERSION__: string;
  interface Window {
    cockpit: CockpitApi;
  }
}

export {};
