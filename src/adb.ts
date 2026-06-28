/**
 * adb.ts — the single chokepoint through which every Android command flows.
 *
 * Design note: we run the real `adb` binary as a subprocess rather than
 * reimplementing the adb wire protocol. That keeps us honest about working on
 * "any app" — adb talks to the system, not to the app, so nothing here assumes
 * a debug build or app cooperation.
 *
 * Two output modes matter:
 *   - text  (`adb shell ...`)      → command output as a string
 *   - binary (`adb exec-out ...`)  → raw bytes (screencap PNGs, file cat),
 *     using exec-out specifically because plain `adb shell` mangles binary
 *     streams with CRLF translation on some hosts.
 */

const ADB =
  process.env.ADB_PATH ||
  (process.env.ANDROID_HOME
    ? `${process.env.ANDROID_HOME}/platform-tools/adb`
    : "adb");

/** The device the server targets. Set once via selectDevice(); null = "let adb pick". */
let targetSerial: string | null = process.env.ANDROID_SERIAL || null;

export function setTargetSerial(serial: string | null) {
  targetSerial = serial;
}
export function getTargetSerial() {
  return targetSerial;
}

/** Prepend `-s <serial>` so multi-device hosts don't throw "more than one device". */
function withSerial(args: string[]): string[] {
  return targetSerial ? ["-s", targetSerial, ...args] : args;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run an adb command and collect stdout as UTF-8 text. */
export async function adb(
  args: string[],
  timeoutMs = 15_000,
): Promise<ExecResult> {
  const proc = Bun.spawn([ADB, ...withSerial(args)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/** Run an adb command and collect stdout as raw bytes (for screencap / file cat). */
export async function adbBinary(
  args: string[],
  timeoutMs = 30_000,
): Promise<Buffer> {
  const proc = Bun.spawn([ADB, ...withSerial(args)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [bytes, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(
        `adb ${args.join(" ")} failed (exit ${exitCode}): ${err}`,
      );
    }
    return Buffer.from(bytes);
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: run something inside `adb shell` and return trimmed stdout. */
export async function shell(
  command: string,
  timeoutMs = 15_000,
): Promise<string> {
  const { stdout, stderr, exitCode } = await adb(["shell", command], timeoutMs);
  if (exitCode !== 0) {
    throw new Error(
      `adb shell '${command}' failed: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
}

export interface DeviceInfo {
  serial: string;
  state: string; // device | offline | unauthorized
  model?: string;
}

/** Parse `adb devices -l` into structured rows. */
export async function listDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await adb(["devices", "-l"]);
  return stdout
    .split("\n")
    .slice(1) // drop "List of devices attached"
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const modelTok = rest.find((t) => t.startsWith("model:"));
      return { serial, state, model: modelTok?.slice("model:".length) };
    });
}

export interface ScreenSize {
  width: number;
  height: number;
}

/** Physical screen resolution, read from `wm size`. Needed to compute swipe geometry. */
export async function getScreenSize(): Promise<ScreenSize> {
  const out = await shell("wm size");
  // "Physical size: 1080x2400" (and sometimes an "Override size:" line)
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const m = override || physical;
  if (!m) throw new Error(`Could not parse screen size from: ${out}`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}
