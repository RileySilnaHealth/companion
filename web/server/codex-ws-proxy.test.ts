import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

const PROXY_PATH = fileURLToPath(new URL("./codex-ws-proxy.cjs", import.meta.url));

/** Ask the OS for a port nothing is listening on, then release it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("codex-ws-proxy startup connection handling", () => {
  let proxy: ChildProcess | null = null;
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    proxy?.kill("SIGKILL");
    proxy = null;
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = null;
  });

  // Regression: Codex's app-server needs a second or two to bind its port, so the
  // proxy's first connects are refused. A refused connect fires BOTH "error" and
  // "close" on the same socket; when each handler scheduled its own connect(),
  // in-flight attempts doubled every round (1, 2, 4, 8...). Every one of those
  // sockets then connected once the server came up, each overwriting the proxy's
  // active socket — so `initialize` went out on one connection and `thread/start`
  // on another, and Codex rejected the second with "Not initialized", bricking the
  // session. The proxy must never have more than one connection attempt pending.
  it("opens exactly one connection when the server starts listening late", async () => {
    const port = await freePort();
    proxy = spawn("node", [PROXY_PATH, `ws://127.0.0.1:${port}`, "30000", "30000"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Let several connects get refused — enough rounds for the doubling to show.
    await wait(800);

    const connections: WsSocket[] = [];
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => connections.push(socket));

    await wait(1500);

    expect(connections.length).toBe(1);
  });

  // The same double-fire happens on the reconnect path: once the server is gone,
  // every refused retry fires error AND close, and each used to call
  // scheduleReconnect(). That scheduled two connects and burned two of the ten
  // MAX_RECONNECT_ATTEMPTS per round, so the proxy gave up in half the intended
  // window. The tell is two "Reconnecting in" logs microseconds apart — on the
  // unfixed proxy the gaps between logs run [202, 0, 402, 0, 400, 0, ...].
  it("schedules one reconnect per drop instead of two", async () => {
    const port = await freePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });

    proxy = spawn("node", [PROXY_PATH, `ws://127.0.0.1:${port}`, "30000", "30000"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const logTimes: number[] = [];
    proxy.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.includes("Reconnecting in")) logTimes.push(Date.now());
      }
    });

    await wait(900);

    // Take the whole server away so every reconnect attempt is refused.
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;

    await wait(2500);

    expect(logTimes.length).toBeGreaterThan(0);
    const gaps = logTimes.slice(1).map((t, i) => t - logTimes[i]);
    // Backoff starts at 200ms, so any near-instant pair means two reconnects
    // were scheduled for one drop.
    expect(gaps.filter((gap) => gap < 50)).toEqual([]);
  });

  // The surviving socket must still be wired up: a line written to the proxy's
  // stdin reaches the server, and a frame from the server reaches stdout.
  it("relays traffic over the connection it keeps", async () => {
    const port = await freePort();
    const received: string[] = [];
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        received.push(data.toString());
        socket.send(JSON.stringify({ id: 1, result: {} }));
      });
    });

    proxy = spawn("node", [PROXY_PATH, `ws://127.0.0.1:${port}`, "30000", "30000"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    proxy.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });

    await wait(1000);
    proxy.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");

    await wait(1000);

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toMatchObject({ method: "initialize" });
    expect(stdout).toContain('"result"');
  });
});
