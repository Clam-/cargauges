import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocketServer, WebSocket } from "ws";

const WS_PORT = 8069;
const BAUD_RATE = 115200;

// Passive monitoring init: same CAN bus params but no request headers/filters
const PASSIVE_INIT_CMDS = [
  "ATD",       // Reset to defaults
  "ATE0",      // Echo off
  "ATS0",      // Spaces off
  "ATH1",      // Headers on (show CAN IDs)
  "ATAL",      // Allow long messages
  "ATPBE101",  // Protocol B: 500kbps, 11-bit CAN, variable DLC
  "ATSPB",     // Select Protocol B
  "ATBI",      // Bypass init sequence
  "ATCAF0",    // CAN auto-formatting OFF — raw frames with DLC
  "STCMM 0",  // Silent monitoring: receive only, no ACKs
];

// ---------------------------------------------------------------------------
// CAN signal map — configure for your BMW model
// Use discovery mode to identify active CAN IDs, then add entries here.
// ---------------------------------------------------------------------------

interface CanSignal {
  name: string;
  startByte: number;
  length: number;
  scale: number;
  offset: number;
  signed: boolean;
}

interface CanMessageDef {
  id: number;
  name: string;
  signals: CanSignal[];
}

// Populate with your vehicle's broadcast CAN message definitions.
// These vary by BMW model — use discovery mode to identify IDs first.
//
// Example (hypothetical):
// { id: 0x1A5, name: "speed_msg", signals: [
//   { name: "speed", startByte: 0, length: 2, scale: 0.0625, offset: 0, signed: false }
// ]},
const CAN_MAP: CanMessageDef[] = [];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CanIdStats {
  count: number;
  firstSeen: number;
  lastSeen: number;
  lastData: string;
  intervalMs: number;
  prevTimestamp: number;
}

let port: SerialPort | null = null;
let ready = false;
let monitoring = false;
let portScanTimer: ReturnType<typeof setInterval> | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
let consoleTimer: ReturnType<typeof setInterval> | null = null;

const canStats = new Map<number, CanIdStats>();
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set<WebSocket>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcast(msg: object) {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

function writeln(data: string) {
  if (port && port.isOpen) {
    port.write(data + "\r\n");
  }
}

function waitReady(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    ready = false;
    const start = Date.now();
    const check = () => {
      if (ready || Date.now() - start > timeout) {
        resolve();
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// CAN frame parsing
// ---------------------------------------------------------------------------

// With ATH1 + ATS0 + ATCAF0, raw CAN frame format:
//   <CAN_ID: 3 hex chars><DLC: 1 hex char><DATA: DLC*2 hex chars>
// Example: "1A580011223344556677" = ID 0x1A5, DLC 8, 8 data bytes
function parseRawFrame(line: string): { id: number; dlc: number; data: string } | null {
  if (line.length < 5) return null;

  const idHex = line.slice(0, 3);
  const dlcChar = line[3];
  const data = line.slice(4);

  const id = parseInt(idHex, 16);
  const dlc = parseInt(dlcChar, 16);

  if (isNaN(id) || isNaN(dlc) || dlc > 8) return null;
  if (data.length < dlc * 2) return null;

  return { id, dlc, data: data.slice(0, dlc * 2) };
}

function extractSignalValue(data: string, signal: CanSignal): number {
  const hex = data.slice(signal.startByte * 2, (signal.startByte + signal.length) * 2);
  let raw = parseInt(hex, 16);
  if (signal.signed) {
    const bits = signal.length * 8;
    if (raw & (1 << (bits - 1))) raw -= 1 << bits;
  }
  return raw * signal.scale + signal.offset;
}

function processCanFrame(line: string) {
  const frame = parseRawFrame(line);
  if (!frame) return;

  const now = Date.now();
  const existing = canStats.get(frame.id);

  if (existing) {
    const dt = now - existing.prevTimestamp;
    existing.intervalMs =
      existing.intervalMs > 0 ? existing.intervalMs * 0.8 + dt * 0.2 : dt;
    existing.count++;
    existing.lastSeen = now;
    existing.lastData = frame.data;
    existing.prevTimestamp = now;
  } else {
    canStats.set(frame.id, {
      count: 1,
      firstSeen: now,
      lastSeen: now,
      lastData: frame.data,
      intervalMs: 0,
      prevTimestamp: now,
    });
  }

  // Emit mapped signals in the same format the active relay uses
  const def = CAN_MAP.find((m) => m.id === frame.id);
  if (def) {
    const result: Record<string, number> = {};
    for (const sig of def.signals) {
      result[sig.name] = extractSignalValue(frame.data, sig);
    }
    if (Object.keys(result).length > 0) broadcast(result);
  }
}

// ---------------------------------------------------------------------------
// Discovery broadcast — sends CAN bus summary to WebSocket clients
// ---------------------------------------------------------------------------

function startDiscoveryBroadcast() {
  if (discoveryTimer) return;
  discoveryTimer = setInterval(() => {
    if (canStats.size === 0) return;

    const ids: Array<{
      id: string;
      count: number;
      rateHz: number;
      lastData: string;
    }> = [];

    for (const [id, stats] of canStats) {
      ids.push({
        id: "0x" + id.toString(16).toUpperCase().padStart(3, "0"),
        count: stats.count,
        rateHz: stats.intervalMs > 0 ? Math.round(1000 / stats.intervalMs) : 0,
        lastData: stats.lastData,
      });
    }

    ids.sort((a, b) => a.id.localeCompare(b.id));
    broadcast({ type: "can_discovery", ids, totalIds: ids.length });
  }, 1000);
}

function stopDiscoveryBroadcast() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Console output — periodic CAN bus activity summary
// ---------------------------------------------------------------------------

function startConsoleSummary() {
  if (consoleTimer) return;
  consoleTimer = setInterval(() => {
    if (canStats.size === 0) return;

    const entries = [...canStats.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20);

    console.clear();
    console.log("=== CAN Bus Passive Monitor ===");
    console.log(`Unique CAN IDs: ${canStats.size} | Monitoring: ${monitoring}`);
    console.log("");
    console.log(
      "ID".padEnd(8) +
        "Rate".padEnd(8) +
        "Count".padEnd(10) +
        "Last Data"
    );
    console.log("-".repeat(60));

    for (const [id, stats] of entries) {
      const idStr = "0x" + id.toString(16).toUpperCase().padStart(3, "0");
      const rate =
        stats.intervalMs > 0
          ? (1000 / stats.intervalMs).toFixed(0) + "Hz"
          : "?";
      console.log(
        idStr.padEnd(8) +
          rate.padEnd(8) +
          stats.count.toString().padEnd(10) +
          stats.lastData
      );
    }
  }, 2000);
}

function stopConsoleSummary() {
  if (consoleTimer) {
    clearInterval(consoleTimer);
    consoleTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Serial port management
// ---------------------------------------------------------------------------

async function listSerialPorts(): Promise<{ path: string; manufacturer?: string }[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer }));
}

async function broadcastPortList() {
  const ports = await listSerialPorts();
  broadcast({
    type: "serial_ports",
    ports,
    connected: port?.isOpen ? port.path : null,
  });
}

async function disconnectSerial() {
  if (monitoring && port && port.isOpen) {
    port.write("\r");
    monitoring = false;
  }
  stopDiscoveryBroadcast();
  stopConsoleSummary();

  if (port && port.isOpen) {
    return new Promise<void>((resolve) => {
      port!.close(() => {
        port = null;
        ready = false;
        canStats.clear();
        resolve();
      });
    });
  }
  port = null;
}

async function runInit() {
  for (const cmd of PASSIVE_INIT_CMDS) {
    writeln(cmd);
    await waitReady(2000);
  }
  console.log("Passive init complete");
}

function startMonitoring() {
  monitoring = true;
  canStats.clear();
  writeln("STMA");
  startDiscoveryBroadcast();
  startConsoleSummary();
  console.log("CAN bus monitoring started (STMA — silent, all IDs)");
}

async function stopMonitoring() {
  if (!monitoring) return;
  if (port && port.isOpen) {
    port.write("\r");
  }
  monitoring = false;
  stopDiscoveryBroadcast();
  stopConsoleSummary();
  await waitReady(2000);
  console.log("CAN bus monitoring stopped");
}

async function initSerial(path: string) {
  port = new SerialPort({ path, baudRate: BAUD_RATE });

  const parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

  parser.on("data", (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "OK") {
      ready = true;
      return;
    }
    if (trimmed === ">") {
      ready = true;
      return;
    }
    if (trimmed === "STOPPED") {
      monitoring = false;
      ready = true;
      console.log("Monitor stopped by device");
      return;
    }
    if (trimmed === "CAN ERROR" || trimmed === "BUS ERROR") {
      console.error("Bus error:", trimmed);
      return;
    }

    if (monitoring) {
      processCanFrame(trimmed);
    }
  });

  port.on("open", async () => {
    console.log(`Serial port ${path} opened`);
    await runInit();
    startMonitoring();
  });

  port.on("error", (err) => {
    console.error("Serial error:", err.message);
  });

  port.on("close", () => {
    console.log("Serial port closed");
    port = null;
    monitoring = false;
    stopDiscoveryBroadcast();
    stopConsoleSummary();
    broadcastPortList();
  });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

wss.on("connection", async (ws) => {
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  const ports = await listSerialPorts();
  ws.send(
    JSON.stringify({
      type: "serial_ports",
      ports,
      connected: port?.isOpen ? port.path : null,
    })
  );

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "list_ports") {
        await broadcastPortList();
      } else if (data.type === "select_port") {
        if (data.path) {
          if (port?.isOpen && port.path === data.path) return;
          await disconnectSerial();
          console.log(`Connecting to serial port: ${data.path}`);
          await initSerial(data.path);
          await broadcastPortList();
        } else {
          await disconnectSerial();
          console.log("Serial port disconnected by user");
          await broadcastPortList();
        }
      } else if (data.type === "clear_stats") {
        canStats.clear();
      } else if (data.type === "stop_monitor") {
        await stopMonitoring();
      } else if (data.type === "start_monitor") {
        if (port?.isOpen && !monitoring) startMonitoring();
      }
    } catch {}
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== CAN Bus Passive Monitor ===");
  console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);
  console.log("");
  console.log("This mode listens to CAN bus traffic without sending any requests.");
  console.log("Broadcast CAN messages from ECUs will be captured and displayed.");
  console.log("");
  console.log("NOTE: UDS diagnostic data (service 0x22 ReadDataByIdentifier) requires");
  console.log("      active polling and will NOT appear unless another device is polling.");
  console.log("      Broadcast messages (speed, steering, etc.) ARE available passively.");
  console.log("");
  console.log("Waiting for device selection from UI...");

  portScanTimer = setInterval(async () => {
    if (clients.size > 0) await broadcastPortList();
  }, 3000);
}

main();
