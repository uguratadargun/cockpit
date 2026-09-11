const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

/**
 * electron-builder afterSign hook: ad-hoc signs the mac app (`-s -`, no cert needed).
 *
 * Apple Silicon refuses to run a completely unsigned arm64 binary at all — Gatekeeper
 * reports it as "damaged" rather than the usual "unidentified developer" warning, and
 * there is no bypass for that dialog. Ad-hoc signing satisfies the execution requirement;
 * it does not pass notarization, so a normal, bypassable Gatekeeper prompt still shows
 * on a fresh download. A real Developer ID cert + notarization is what removes that too.
 */
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
