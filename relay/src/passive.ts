import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocketServer, WebSocket } from "ws";

const WS_PORT = 8069;
const BAUD_RATE = 2000000;

// Phase 1: Basic adapter initialization
const BASE_INIT_CMDS = [
  "ATD",       // Reset to defaults
  "ATE0",      // Echo off
  "ATS0",      // Spaces off
  "ATH1",      // Headers on (show CAN IDs)
  "ATAL",      // Allow long messages
  "ATPBE101",  // Protocol B: 500kbps, 11-bit CAN, variable DLC
  "ATSPB",     // Select Protocol B
  "STPO",      // Open current protocol
];

// Phase 2: BDC (Body Domain Controller) gateway activation
// The D-CAN bus (OBD port) carries no broadcast traffic by default.
// Opening an Extended Diagnostic Session with the BDC tells it to
// forward PT-CAN / K-CAN frames onto D-CAN.
const BDC_ECU_ID = "40";
const BDC_SETUP_CMDS = [
  "ATSH6F1",
  "STCFCPC",
  `STCFCPA 6F1 ${BDC_ECU_ID}, 6${BDC_ECU_ID} F1`,
  `STCAF 1, ${BDC_ECU_ID}`,
  `ATCRA6${BDC_ECU_ID}`,
];

const TESTER_PRESENT_INTERVAL_MS = 2000;

// Phase 4: Transition to raw CAN monitoring
const MONITOR_TRANSITION_CMDS = [
  "STCAF 0",   // Back to normal addressing
  "STFA",      // Enable automatic filtering — accept all IDs
  "ATD 1",     // DLC printing on (parseRawFrame expects it)
  "ATCAF0",    // CAN auto-formatting OFF — raw frames
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
let initResponseCallback: ((line: string) => void) | null = null;

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

function sendAndCapture(cmd: string, timeout: number): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    initResponseCallback = (line) => {
      lines.push(line);
    };
    writeln(cmd);
    waitReady(timeout).then(() => {
      initResponseCallback = null;
      resolve(lines.join("\n"));
    });
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
  if (port && port.isOpen) {
    if (monitoring) {
      port.write("\r");
      monitoring = false;
      await waitReady(1000);
    }
    writeln("STPPMC");
    await waitReady(1000);
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
  // Phase 1: Basic adapter init
  console.log("[passive] Phase 1: Adapter init...");
  for (const cmd of BASE_INIT_CMDS) {
    writeln(cmd);
    await waitReady(2000);
  }

  // Phase 2: Open Extended Diagnostic Session with BDC gateway
  console.log("[passive] Phase 2: BDC gateway activation...");
  for (const cmd of BDC_SETUP_CMDS) {
    writeln(cmd);
    await waitReady(2000);
  }
  const sessionResp = await sendAndCapture("1003", 3000);
  if (sessionResp.includes("5003")) {
    console.log("[passive] BDC Extended Diagnostic Session opened");
  } else if (sessionResp === "NO DATA" || sessionResp === "") {
    console.warn("[passive] BDC did not respond — gateway may not forward traffic");
  } else if (sessionResp.includes("7F")) {
    console.warn(`[passive] BDC rejected session: ${sessionResp}`);
  } else {
    console.warn(`[passive] BDC response: ${sessionResp}`);
  }

  // Phase 3: Periodic TesterPresent (keep BDC session alive during monitoring)
  // STCMM 1 = normal node (ACKs + allows periodic tx while STMA is running)
  console.log("[passive] Phase 3: Periodic TesterPresent...");
  writeln("STCMM 1");
  await waitReady(2000);
  const tpResp = await sendAndCapture(
    `STPPMA ${TESTER_PRESENT_INTERVAL_MS}, 6F1, 3E80`,
    2000,
  );
  if (tpResp) {
    console.log(`[passive] TesterPresent registered (handle ${tpResp})`);
  }

  // Phase 4: Transition to raw CAN monitoring mode
  console.log("[passive] Phase 4: Monitoring setup...");
  for (const cmd of MONITOR_TRANSITION_CMDS) {
    writeln(cmd);
    await waitReady(2000);
  }

  console.log("[passive] Init complete");
}

function startMonitoring() {
  monitoring = true;
  canStats.clear();
  writeln("STMA");
  startDiscoveryBroadcast();
  startConsoleSummary();
  console.log("[passive] CAN bus monitoring started (STMA)");
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
  console.log("[passive] CAN bus monitoring stopped");
}

async function initSerial(path: string) {
  port = new SerialPort({ path, baudRate: BAUD_RATE });

  const parser = port.pipe(new ReadlineParser({ delimiter: "\r" }));

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
      console.log("[passive] Monitor stopped by device");
      return;
    }

    if (initResponseCallback) {
      initResponseCallback(trimmed);
      return;
    }

    if (trimmed === "CAN ERROR" || trimmed === "BUS ERROR") {
      console.error("[passive] Bus error:", trimmed);
      return;
    }

    if (monitoring) {
      processCanFrame(trimmed);
    }
  });

  port.on("open", async () => {
    console.log(`[passive] Serial port ${path} opened`);
    await runInit();
    startMonitoring();
  });

  port.on("error", (err) => {
    console.error("[passive] Serial error:", err.message);
  });

  port.on("close", () => {
    console.log("[passive] Serial port closed");
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
  console.log("=== CAN Bus Passive Monitor (BDC Gateway Mode) ===");
  console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);
  console.log("");
  console.log("On connect this will:");
  console.log("  1. Open an Extended Diagnostic Session with the BDC (ECU 0x40)");
  console.log("  2. Send periodic TesterPresent to keep the session alive");
  console.log("  3. Monitor all CAN traffic forwarded by the gateway");
  console.log("");
  console.log("Waiting for device selection from UI...");

  portScanTimer = setInterval(async () => {
    if (clients.size > 0) await broadcastPortList();
  }, 3000);
}

main();
