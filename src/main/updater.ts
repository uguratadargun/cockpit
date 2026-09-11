import { app, shell } from "electron";
import { autoUpdater } from "electron-updater";

import { push } from "../shared/ipc";
import type { UpdateStatus } from "../shared/types";
import { isNewer } from "./setup";

const REPO = "uguratadargun/cockpit";
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

/**
 * Windows and Linux's AppImage build get electron-updater's normal silent
 * download-then-quitAndInstall flow. The macOS build here is only ad-hoc
 * signed (see afterSignAdhoc.cjs) — no paid Developer ID certificate —
 * and Squirrel.Mac refuses to apply an update unless both the running app
 * and the downloaded one carry a real signature it can verify. So macOS
 * instead gets a manual check against GitHub's "latest release" feed and a
 * link to it; there is no silent install path until the app is properly
 * signed and notarized.
 */
export function initUpdater(send: (channel: string, payload: unknown) => void): void {
  if (!app.isPackaged) return; // a dev build has no publish feed to check against

  if (process.platform === "darwin") {
    const check = () => void checkMacUpdate(send);
    check();
    setInterval(check, CHECK_INTERVAL_MS).unref();
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const status = (partial: Partial<UpdateStatus>): void =>
    send(push.updateStatus, { available: false, version: null, downloaded: false, error: null, mode: "auto", ...partial });

  autoUpdater.on("update-available", (info) => status({ available: true, version: info.version }));
  autoUpdater.on("update-downloaded", (info) => status({ available: true, version: info.version, downloaded: true }));
  autoUpdater.on("error", (err) => status({ error: err.message }));

  const check = () => void autoUpdater.checkForUpdates().catch((err: Error) => status({ error: err.message }));
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}

/** Windows/Linux: installs what electron-updater already staged, and restarts. macOS: just opens the release page. */
export function installUpdate(): void {
  if (process.platform === "darwin") {
    void shell.openExternal(`https://github.com/${REPO}/releases/latest`);
    return;
  }
  autoUpdater.quitAndInstall();
}

async function checkMacUpdate(send: (channel: string, payload: unknown) => void): Promise<void> {
  const status = (partial: Partial<UpdateStatus>): void =>
    send(push.updateStatus, { available: false, version: null, downloaded: false, error: null, mode: "manual", ...partial });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error(`github said ${res.status}`);
    const data = (await res.json()) as { tag_name?: string };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    if (latest && isNewer(latest, app.getVersion())) status({ available: true, version: latest });
  } catch (e) {
    status({ error: (e as Error).message });
  }
}
