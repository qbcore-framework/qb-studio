/**
 * Optional remote host support.
 *
 * This module is only reached when `StudioConfig.remote` is set. With no remote
 * host configured, `managedRuntime.ts` behaves exactly as before.
 *
 * The loopback policy is not relaxed. It is satisfied honestly on both ends:
 *
 *   - the runtime binds 127.0.0.1 on the remote host,
 *   - RCON stays 127.0.0.1 there, so the Quake3-style UDP packets that carry
 *     `rcon_password` in plaintext never leave that machine,
 *   - the desktop app connects to 127.0.0.1 on a forwarded port here,
 *   - SSH provides encryption, authentication, and host-key verification
 *     between the two.
 *
 * `networkPolicy.ts` and the runtime itself are unchanged.
 *
 * Secret handling: the launch script is delivered over SSH stdin (`sh -s`), so
 * no value appears in `argv` (visible via `ps` to other users on the host) or
 * on disk. `rcon_password` is read out of server.cfg *by the remote script*, so
 * it is never transmitted to the client at all.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import type { RemoteHostSettings } from "./configStore";
import type { ManagedRuntimeConnection } from "./managedRuntime";

/** Matches the line the runtime always writes to stderr on listen. */
const READY_PATTERN = /listening on http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\//;

const READY_TIMEOUT_MS = 20_000;
const FORWARD_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 8192;

const SSH_BASE_OPTIONS = [
  // Never block the UI on an interactive password or host-key prompt.
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
];

let runtimeChild: ChildProcess | null = null;
let forwardChild: ChildProcess | null = null;
let connection: ManagedRuntimeConnection | null = null;
let activeKey: string | null = null;
let starting: Promise<ManagedRuntimeConnection> | null = null;

/** POSIX single-quote quoting for values interpolated into the remote script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteKey(settings: RemoteHostSettings): string {
  return [
    settings.sshTarget,
    settings.workspacePath,
    settings.serverConfigPath,
    settings.txAdminDataDir ?? "",
    settings.txAdminControlProfile ?? "",
    String(settings.rconPort),
    settings.runtimePath,
  ].join("\0");
}

/**
 * Builds the script piped to `ssh <target> sh -s`.
 *
 * `rcon_password` is extracted here, on the host, from the same server.cfg the
 * runtime is told to use. It never crosses the network.
 */
export function buildLaunchScript(settings: RemoteHostSettings, token: string): string {
  const cfg = shellQuote(settings.serverConfigPath);
  return [
    "set -e",
    `CFG=${cfg}`,
    `if [ ! -r "$CFG" ]; then echo "qb-studio: cannot read $CFG on the remote host" >&2; exit 66; fi`,
    // Take the first `set rcon_password <value>` and strip optional quoting.
    `RCON_PASSWORD=$(sed -n 's/^[[:space:]]*set[[:space:]]\\{1,\\}rcon_password[[:space:]]\\{1,\\}//p' "$CFG" | head -n 1 | sed 's/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')`,
    `if [ -z "$RCON_PASSWORD" ]; then echo "qb-studio: no 'set rcon_password' found in $CFG" >&2; exit 67; fi`,
    "export RCON_PASSWORD",
    "export MCP_TRANSPORT=http",
    "export MCP_HOST=127.0.0.1",
    // 0 lets the host pick a free port; we read it back off stderr.
    "export MCP_PORT=0",
    `export MCP_TOKEN=${shellQuote(token)}`,
    "export RCON_HOST=127.0.0.1",
    `export RCON_PORT=${shellQuote(String(settings.rconPort))}`,
    `export SERVER_DATA_WORKSPACE=${shellQuote(settings.workspacePath)}`,
    `export SERVER_CONFIG_PATH=${shellQuote(settings.serverConfigPath)}`,
    `export TXADMIN_DATA_DIR=${shellQuote(settings.txAdminDataDir ?? "")}`,
    `export TXADMIN_CONTROL_PROFILE=${shellQuote(settings.txAdminControlProfile ?? "")}`,
    `exec ${shellQuote(settings.nodePath)} ${shellQuote(settings.runtimePath)}`,
  ].join("\n");
}

function runSsh(settings: RemoteHostSettings, remoteCommand: string[], input?: string | Buffer): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_BASE_OPTIONS, settings.sshTarget, ...remoteCommand], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Uploads the bundled runtime when the host copy is absent or differs. */
async function ensureRuntimeDeployed(settings: RemoteHostSettings, localRuntimePath: string): Promise<void> {
  if (!fs.existsSync(localRuntimePath)) {
    throw new Error("The bundled coding runtime is missing. Reinstall QB Studio or run the runtime bundle build.");
  }
  const payload = fs.readFileSync(localRuntimePath);
  const localDigest = createHash("sha256").update(payload).digest("hex");

  const probe = await runSsh(settings, ["sh", "-s"], `sha256sum ${shellQuote(settings.runtimePath)} 2>/dev/null | cut -d' ' -f1`);
  if (probe.code === 0 && probe.stdout.trim() === localDigest) return;

  // The script must arrive as argv, not stdin: `cat` consumes all of stdin, so
  // a script piped ahead of the payload would swallow its own remaining lines.
  const target = shellQuote(settings.runtimePath);
  const upload = await runSsh(
    settings,
    ["sh", "-c", `umask 077; cat > ${target}.part && mv ${target}.part ${target}`],
    payload,
  );
  if (upload.code !== 0) {
    throw new Error(`Could not deploy the coding runtime to ${settings.sshTarget}: ${upload.stderr.trim() || `ssh exited ${upload.code}`}`);
  }
}

async function pickFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("Could not reserve a local port for the SSH tunnel."))));
    });
  });
}

function connectOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function waitForLocalPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connectOnce(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The SSH tunnel did not become reachable in time.");
}

/** Phase A: start the runtime on the host and read back the port it chose. */
function startRemoteRuntimeProcess(settings: RemoteHostSettings, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_BASE_OPTIONS, settings.sshTarget, "sh", "-s"], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    runtimeChild = child;

    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (runtimeChild === child) runtimeChild = null;
        if (!child.killed) child.kill();
        reject(error);
      } else resolve(port as number);
    };

    const timer = setTimeout(
      () => finish(new Error(`The coding runtime on ${settings.sshTarget} did not report a listening port within 20 seconds.${stderr ? ` ${stderr.trim()}` : ""}`)),
      READY_TIMEOUT_MS,
    );
    timer.unref();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
      const match = READY_PATTERN.exec(stderr);
      if (!match) return;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) finish(null, port);
    });
    child.on("error", (error) => finish(new Error(`Could not reach ${settings.sshTarget} over SSH: ${error.message}`)));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`The remote coding runtime exited with code ${code ?? "unknown"}.${stderr ? ` ${stderr.trim()}` : ""}`));
      else if (runtimeChild === child) {
        runtimeChild = null;
        connection = null;
        activeKey = null;
      }
    });

    child.stdin?.end(buildLaunchScript(settings, token));
  });
}

/** Phase B: forward a local port to the port the runtime chose on the host. */
function startForward(settings: RemoteHostSettings, localPort: number, remotePort: number): ChildProcess {
  const child = spawn(
    "ssh",
    [
      ...SSH_BASE_OPTIONS,
      "-o", "ExitOnForwardFailure=yes",
      "-N",
      "-L", `${localPort}:127.0.0.1:${remotePort}`,
      settings.sshTarget,
    ],
    { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] },
  );
  forwardChild = child;
  child.on("exit", () => {
    if (forwardChild === child) {
      forwardChild = null;
      connection = null;
      activeKey = null;
    }
  });
  return child;
}

export async function ensureRemoteRuntime(
  settings: RemoteHostSettings,
  localRuntimePath: string,
): Promise<ManagedRuntimeConnection> {
  const key = remoteKey(settings);
  if (connection && runtimeChild && !runtimeChild.killed && activeKey === key) return connection;
  if (starting && activeKey === key) return starting;
  stopRemoteRuntime();
  activeKey = key;

  const token = randomBytes(32).toString("base64url");
  const startup = (async () => {
    await ensureRuntimeDeployed(settings, localRuntimePath);
    const remotePort = await startRemoteRuntimeProcess(settings, token);
    const localPort = await pickFreeLocalPort();
    startForward(settings, localPort, remotePort);
    await waitForLocalPort(localPort, FORWARD_TIMEOUT_MS);
    connection = {
      url: `http://127.0.0.1:${localPort}/mcp`,
      token,
      serverIdentity: {
        workspacePath: settings.workspacePath,
        serverConfigPath: settings.serverConfigPath,
        rcon: { host: "127.0.0.1", port: settings.rconPort },
      },
    };
    return connection;
  })();

  const tracked = startup.catch((error) => {
    stopRemoteRuntime();
    throw error;
  }).finally(() => {
    if (starting === tracked) starting = null;
  });
  starting = tracked;
  return tracked;
}

export function stopRemoteRuntime(): void {
  const stoppingRuntime = runtimeChild;
  const stoppingForward = forwardChild;
  runtimeChild = null;
  forwardChild = null;
  connection = null;
  activeKey = null;
  if (stoppingForward && !stoppingForward.killed) stoppingForward.kill();
  if (stoppingRuntime && !stoppingRuntime.killed) stoppingRuntime.kill();
}
