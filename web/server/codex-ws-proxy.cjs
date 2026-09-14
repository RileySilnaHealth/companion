#!/usr/bin/env node
"use strict";

// Bridges newline-delimited JSON on stdin/stdout to WebSocket text frames for
// Codex app-server. Runs in real Node (not Bun) so the `ws` package handles the
// Codex Rust server handshake correctly with perMessageDeflate disabled.

const readline = require("node:readline");
const WebSocket = require("ws");

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] || "30000");
const pongTimeoutArg = process.argv[4];

if (!url) {
  process.stderr.write("[codex-ws-proxy] Missing URL argument\n");
  process.exit(2);
}

let ws = null;
let opened = false;
let closed = false;
let exiting = false;
let queue = [];
let connectAttempt = 0;
const startedAt = Date.now();

// A failed connection fires BOTH "error" and "close" on the same socket, and a
// post-open drop does the same. Each used to schedule its own connect(), so
// in-flight attempts doubled every round (1, 2, 4, 8...). The extra sockets all
// connect once Codex starts listening, each overwriting `ws`, which splits the
// JSON-RPC handshake across connections: `initialize` lands on one socket and
// `thread/start` on another, and Codex rejects the latter with "Not
// initialized". One pending attempt at a time keeps the session on one socket.
let retryTimer = null;

// Reconnection state — after a successful initial connection, transient
// WebSocket drops are retried with exponential backoff before giving up.
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;
let reconnecting = false;
let reconnectAttempt = 0;

// Heartbeat — detect zombie WebSocket connections where the TCP socket is open
// but the remote Codex process has stopped responding.
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = pongTimeoutArg ? Number(pongTimeoutArg) : 30000;
let pingTimer = null;
let pongTimer = null;

function log(msg) {
  process.stderr.write(`[codex-ws-proxy] ${msg}\n`);
}

function startHeartbeat() {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    ws.ping();
    pongTimer = setTimeout(() => {
      log("Pong timeout — connection appears dead");
      try { ws.terminate(); } catch {}
      // terminate() fires the close event which triggers scheduleReconnect
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

function decodeMessageData(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((x) => Buffer.from(x))).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN || queue.length === 0) return;
  for (const line of queue) {
    ws.send(line);
  }
  queue = [];
}

function failAndExit(message, code = 1) {
  if (exiting) return;
  exiting = true;
  stopHeartbeat();
  log(message);
  try { if (ws) ws.close(); } catch {}
  process.exit(code);
}

/**
 * Queue a single connect() attempt. Calls made while an attempt is already
 * pending are dropped so concurrent sockets never stack up.
 */
function scheduleRetry(delay) {
  if (closed || exiting || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

/**
 * Attempt to reconnect after a post-open WebSocket drop.
 * Uses exponential backoff up to MAX_RECONNECT_ATTEMPTS before giving up.
 */
function scheduleReconnect(reason) {
  if (closed || exiting || retryTimer) return;
  stopHeartbeat();
  reconnectAttempt++;
  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    failAndExit(`WebSocket reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts (last: ${reason})`);
    return;
  }

  reconnecting = true;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX_MS);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}) — ${reason}`);
  scheduleRetry(delay);
}

function connect() {
  if (closed || exiting) return;

  // During initial connection (before first successful open), enforce timeout.
  if (!opened) {
    connectAttempt += 1;
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      failAndExit(`Failed to connect within ${timeoutMs}ms`);
      return;
    }
  }

  const socket = new WebSocket(url, { perMessageDeflate: false });
  ws = socket;
  // Every handler ignores a socket that is no longer the active one, so a
  // straggler from an earlier attempt can never carry protocol traffic.
  const isStale = () => socket !== ws;

  socket.once("open", () => {
    if (isStale()) {
      try { socket.terminate(); } catch {}
      return;
    }
    if (!opened) {
      opened = true;
    }
    const wasReconnect = reconnecting;
    if (reconnecting) {
      log(`Reconnected successfully (attempt ${reconnectAttempt})`);
      reconnecting = false;
      reconnectAttempt = 0;
    }
    startHeartbeat();
    flushQueue();
    // Notify the adapter AFTER flushing any buffered messages so stale Codex
    // responses from the pre-drop session are delivered before the adapter
    // rejects all pending calls and cleans up.
    if (wasReconnect) {
      const reconnectNotification = JSON.stringify({
        method: "companion/wsReconnected",
        params: {},
      });
      process.stdout.write(reconnectNotification + "\n");
    }
  });

  socket.on("message", (data) => {
    if (isStale()) return;
    const raw = decodeMessageData(data);
    // stdout is protocol channel: ONLY write payload lines
    process.stdout.write(raw + "\n");
  });

  socket.on("pong", () => {
    if (isStale()) return;
    // Heartbeat response received — connection is alive
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  });

  socket.once("close", (code, reason) => {
    if (isStale()) return;
    stopHeartbeat();
    if (closed || exiting) return;
    const why = reason ? ` reason=${reason}` : "";
    // If connection closes before we ever opened, keep retrying until timeout.
    if (!opened) {
      scheduleRetry(Math.min(100 * connectAttempt, 500));
      return;
    }
    // Post-open close — attempt reconnection with backoff
    scheduleReconnect(`WebSocket closed (code=${code}${why})`);
  });

  socket.once("error", (err) => {
    if (isStale()) return;
    if (closed || exiting) return;
    // Retry during startup; after a successful connection, use reconnect logic.
    if (!opened) {
      scheduleRetry(Math.min(100 * connectAttempt, 500));
      return;
    }
    // Post-open error — attempt reconnection with backoff
    scheduleReconnect(`WebSocket error: ${err && err.message ? err.message : String(err)}`);
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (closed || exiting) return;
  if (!line) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    queue.push(line);
    return;
  }
  ws.send(line);
});

rl.on("close", () => {
  closed = true;
  stopHeartbeat();
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  closed = true;
  stopHeartbeat();
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  closed = true;
  stopHeartbeat();
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

connect();
