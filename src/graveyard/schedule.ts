// Night scheduler wiring (N3): launchd plists that work the queue at 2am
// and settle it at 6am. `runDueJobs` is idempotent, so both ticks run the
// same command. macOS only; elsewhere this refuses with instructions.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEDULE_HOURS = [2, 6];

export function agentLabel(hour: number): string {
  return `cli.prudence.graveyard.${hour}am`;
}

export function graveyardPlist(opts: {
  label: string;
  hour: number;
  pruBin: string[];
  testCommand: string;
  logPath: string;
}): string {
  const program = opts.pruBin.map((s) => `    <string>${s}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
${program}
    <string>graveyard</string>
    <string>--run</string>
    <string>--test-command</string>
    <string>${opts.testCommand}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${opts.hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${opts.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${opts.logPath}</string>
</dict>
</plist>
`;
}

export function agentsDir(home = process.env.HOME ?? "."): string {
  return join(home, "Library", "LaunchAgents");
}

export function scheduleGraveyard(opts: {
  pruBin: string[];
  testCommand: string;
  home?: string;
  uid?: number;
}): string[] {
  if (process.platform !== "darwin") {
    throw new Error("Pru schedules nights with launchd (macOS). Elsewhere, run `pru graveyard run` from cron.");
  }
  const home = opts.home ?? process.env.HOME ?? ".";
  const dir = agentsDir(home);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const hour of SCHEDULE_HOURS) {
    const label = agentLabel(hour);
    const file = join(dir, `${label}.plist`);
    writeFileSync(
      file,
      graveyardPlist({
        label,
        hour,
        pruBin: opts.pruBin,
        testCommand: opts.testCommand,
        logPath: join(home, ".prudence", `graveyard-${hour}am.log`),
      }),
    );
    written.push(file);
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${opts.uid ?? 501}`, file], { stdio: "ignore" });
    } catch {
      // Best effort: the plist is valid; `launchctl bootstrap` runs at login
      // anyway, or the user loads it by hand (printed by the CLI).
    }
  }
  return written;
}

export function unscheduleGraveyard(opts?: { home?: string; uid?: number }): string[] {
  const home = opts?.home ?? process.env.HOME ?? ".";
  const removed: string[] = [];
  for (const hour of SCHEDULE_HOURS) {
    const file = join(agentsDir(home), `${agentLabel(hour)}.plist`);
    try {
      execFileSync("launchctl", ["bootout", `gui/${opts?.uid ?? 501}`, file], { stdio: "ignore" });
    } catch {
      // Not loaded; still remove the file below.
    }
    try {
      rmSync(file);
      removed.push(file);
    } catch {
      // Already gone.
    }
  }
  return removed;
}
