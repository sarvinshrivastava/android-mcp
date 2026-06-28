/**
 * device.ts — developer utilities that earn their place by condensing or
 * composing, never by 1:1 wrapping an adb command.
 *
 *   current_activity → parses a ~100-line `dumpsys` block into one clean line.
 *   read_logcat      → filters + tails a firehose and auto-flags crashes/ANRs.
 *   reset_app        → clear-data + relaunch (a test concept, two commands).
 */

import { adb, shell } from "./adb.js";
import { snapshot } from "./uitree.js";

/** Cheap, stable 32-bit hash for a screen signature. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Which app/screen is in the foreground right now.
 *
 * Modern apps (Compose / React Native / Flutter) host EVERY screen in one
 * Activity, so the activity name alone can't tell tabs/screens apart. We add a
 * `screenSignature` (a hash of the screen's stable resource-ids) and a best-guess
 * `screenTitle`: two reads with the same activity but different signatures means
 * navigation happened.
 */
export async function currentActivity(): Promise<{
  package: string;
  activity: string;
  screenSignature: string;
  screenTitle: string;
  raw: string;
}> {
  // mResumedActivity / mCurrentFocus carries "pkg/.Activity" on modern Android.
  const out = await shell(
    "dumpsys activity activities | grep -E 'mResumedActivity|mCurrentFocus' | head -2",
  );
  const m = out.match(/([\w.]+)\/([\w.$]+)/);

  // Fingerprint the screen from its element tree.
  let screenSignature = "";
  let screenTitle = "";
  try {
    const snap = await snapshot();
    const ids = snap.elements
      .map((e) => e.resourceId)
      .filter((x): x is string => !!x)
      .sort();
    screenSignature = hash(ids.join("|") || String(snap.rawNodeCount));
    // Heuristic title: the first labelled element in the top fifth of the screen.
    const top = snap.elements
      .filter((e) => e.label && e.bounds[1] < 600)
      .sort((a, b) => a.bounds[1] - b.bounds[1]);
    screenTitle = top[0]?.label?.slice(0, 60) ?? "";
  } catch {
    /* tree unavailable — leave fingerprint blank */
  }

  if (!m) {
    return {
      package: "",
      activity: "",
      screenSignature,
      screenTitle,
      raw: out.trim(),
    };
  }
  return {
    package: m[1],
    activity: m[2],
    screenSignature,
    screenTitle,
    raw: out.trim(),
  };
}

export interface LogcatOptions {
  /** Tag or substring filter applied to message text. */
  filter?: string;
  /** Minimum priority: V D I W E F. Defaults to W (warnings and above). */
  priority?: "V" | "D" | "I" | "W" | "E" | "F";
  /** How many recent lines to return. */
  tail?: number;
  /** Restrict to a package's PID (current foreground app if "foreground"). */
  package?: string;
}

const CRASH_RE = /(FATAL EXCEPTION|ANR in|AndroidRuntime|signal \d+ \(SIG)/;

/** Read recent logcat, condensed: dump-and-exit (-d), tailed, crash-flagged. */
export async function readLogcat(opts: LogcatOptions = {}): Promise<{
  lines: string[];
  crashDetected: boolean;
  crashLines: string[];
}> {
  const priority = opts.priority || "W";
  // -d = dump existing buffer and exit (don't stream forever).
  const args = ["logcat", "-d", "-v", "brief", `*:${priority}`];
  const { stdout } = await adb(args, 20_000);

  let lines = stdout.split("\n").filter((l) => l.trim());
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(f));
  }
  const crashLines = lines.filter((l) => CRASH_RE.test(l));
  const tail = opts.tail ?? 100;
  return {
    lines: lines.slice(-tail),
    crashDetected: crashLines.length > 0,
    crashLines: crashLines.slice(-20),
  };
}

/** Clear app data and relaunch from the launcher intent — a fresh first-run state. */
export async function resetApp(
  pkg: string,
): Promise<{ cleared: boolean; launched: boolean }> {
  await shell(`pm clear ${pkg}`);
  const { exitCode } = await adb([
    "shell",
    "monkey",
    "-p",
    pkg,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
  return { cleared: true, launched: exitCode === 0 };
}
