import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocketServer, WebSocket } from "ws";

const WS_PORT = 8069;
const BAUD_RATE = 2000000;

const INIT_CMDS = [
  "ATD",
  "ATE0",
  "ATS0",
  "ATH1",
  "ATAL",
  "STP 33",
  "STPO",
  "ATSH6F1",
  "STPTO 200",
];

// BDC (Body Domain Controller) gateway — Extended Diagnostic Session
// reduces rate-limiting on polled requests through the gateway.
const BDC_ECU_ID = "40";
const BDC_SETUP_CMDS = [
  "STCFCPC",
  `STCFCPA 6F1 ${BDC_ECU_ID}, 6${BDC_ECU_ID} F1`,
  `STCAF 1, ${BDC_ECU_ID}`,
  `ATCRA6${BDC_ECU_ID}`,
];
const TESTER_PRESENT_INTERVAL_MS = 2000;

interface PidEntry {
  pid: string;
  speed: "fast" | "med" | "slow";
  key: string;
  extraKeys?: string[];
}

const PID_TABLE: PidEntry[] = [
  { pid: "12-DE9C", speed: "fast", key: "accel" },
  { pid: "40-DABD", speed: "fast", key: "speed", extraKeys: ["brake"] },
  { pid: "30-DB57", speed: "fast", key: "steer" },
  { pid: "07-DD69", speed: "fast", key: "power_amps" },
  { pid: "07-DD68", speed: "fast", key: "power_volts" },
  { pid: "63-D031", speed: "med", key: "gear" },
  { pid: "07-DDBC", speed: "slow", key: "batt" },
  { pid: "60-D111", speed: "slow", key: "range" },
  { pid: "78-D92C", speed: "slow", key: "ac" },
  { pid: "60-D112", speed: "slow", key: "acout" },
];

const SPEED_INTERVALS = { fast: 100, med: 1000, slow: 5000 };

let port: SerialPort | null = null;
let ready = false;
let pollInterval = 50;
let portScanTimer: ReturnType<typeof setInterval> | null = null;
let initResponseCallback: ((line: string) => void) | null = null;

const dataStore: Record<string, string> = {};
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set<WebSocket>();

// Multi-frame assembly state
let assemble = "";
let destPid = "";
let remaining = 0;
let seq = 0;
let testerPresentHandle: string | null = null;

function broadcast(msg: object) {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

function longParse(hex: string): number {
  let d = parseInt(hex, 16);
  if (d & 0x80000000) d -= 0x100000000;
  return d;
}

function isTerminalResponse(s: string): boolean {
  return s === "OK" ||
    s === "STOPPED" ||
    s === "NO DATA" ||
    s === "?" ||
    s.startsWith("CAN ERROR") ||
    s === "BUFFER FULL" ||
    s === "DATA ERROR" ||
    s === "ACT ALERT";
}

function parseAndBroadcast(pid: string, data: string) {
  dataStore[pid] = data;

  const entry = PID_TABLE.find(
    (e) => e.pid.split("-")[1] === pid
  );
  if (!entry) {
    console.log(`[parse] unknown PID ${pid}, data="${data}"`);
    return;
  }
  console.log(`[parse] PID ${pid} (${entry.key}), data="${data}"`);

  const result: Record<string, number | string | number[]> = {};

  switch (entry.key) {
    case "accel":
      // Bytes 4-5: STAT_PEDALWERT_WERT (pedal %, 0.0625 per bit)
      if (data.length >= 12) {
        result.accel = parseInt(data.slice(8, 12), 16) * 0.0625;
      }
      break;
    case "speed": {
      // Bytes 0-1: speed (unsigned int / 64 = km/h)
      // Byte 2: speed status
      // Byte 3: brake pedal status
      const spd = parseInt(data.slice(0, 4), 16) / 64;
      const brk = parseInt(data.slice(6, 8), 16);
      result.speed = spd;
      result.brake = brk;
      break;
    }
    case "steer": {
      // Signed long / 100 = pinion angle in degrees
      const deg = longParse(data.slice(0, 8)) / 100;
      // Map to 0-360 for the circular gauge (0 = straight ahead)
      result.steer = ((deg % 360) + 360) % 360;
      break;
    }
    case "power_volts": {
      // Unsigned int / 100 = HV voltage
      const volts = parseInt(data.slice(0, 4), 16) / 100;
      const ampsPid = PID_TABLE.find((e) => e.key === "power_amps");
      const ampsHex = ampsPid ? dataStore[ampsPid.pid.split("-")[1]] : null;
      if (ampsHex) {
        const amps = longParse(ampsHex.slice(0, 8)) / 100;
        result.power = (amps * volts) / 1000;
      }
      break;
    }
    case "power_amps":
      break;
    case "batt": {
      // Bytes 0-1: display SOC (uint / 10 = %)
      // Bytes 2-3: max SOC limit (uint / 10 = %)
      const b1 = parseInt(data.slice(0, 4), 16) / 10;
      const b2 = parseInt(data.slice(4, 8), 16) / 10;
      result.batt = [b1, b2];
      break;
    }
    case "range":
      // Bytes 0-1: electric range current (uint / 10 = km)
      result.range = parseInt(data.slice(0, 4), 16) / 10;
      break;
    case "ac":
      // 0 = AC ON (LED off), 1 = AC OFF (LED on)
      result.ac = parseInt(data.slice(0, 2), 16);
      break;
    case "acout":
      // Byte 0: ambient temp display (unsigned char / 2 - 40 = °C)
      result.acout = parseInt(data.slice(0, 2), 16) / 2 - 40;
      break;
    case "gear": {
      // Byte 0: STAT_DIRECTION (0=reverse, 1=drive, 2=neutral/park)
      const val = parseInt(data.slice(0, 2), 16);
      if (val === 0) result.gear = "R";
      else if (val === 1) result.gear = "D";
      else if (val === 2) result.gear = "N";
      else result.gear = "?";
      break;
    }
  }

  if (Object.keys(result).length > 0) broadcast(result);
}

function setReady() {
  ready = true;
}

function processFrame(line: string) {
  // Strip non-printable characters that may slip through
  line = line.replace(/[^\x20-\x7E]/g, "");

  if (!line || line.length < 6) {
    console.log(`[frame] skipping short/empty line: "${line}"`);
    setReady();
    return;
  }

  const ftype = line[5];
  console.log(`[frame] type=${ftype} line="${line}"`);

  if (ftype === "0") {
    // Single frame
    const svc = line.slice(7, 9);
    if (svc === "7F") {
      // Negative response: 7F <service> <NRC>
      const nrc = parseInt(line.slice(11, 13), 16);
      if (nrc !== 0x78) {
        // Terminal NRC (not "response pending")
        setReady();
      }
      return;
    }
    if (svc !== "62") {
      setReady();
      return;
    }
    const size = parseInt(line[6], 16);
    destPid = line.slice(9, 13);
    assemble = line.slice(13, 13 + (size - 3) * 2);
    remaining = 0;
  } else if (ftype === "1") {
    // First frame of multi
    if (line.slice(9, 11) !== "62") return;
    const totalLen = parseInt(line.slice(6, 9), 16);
    destPid = line.slice(11, 15);
    assemble = line.slice(15);
    seq = 0;
    remaining = (totalLen - 3) * 2 - assemble.length;
  } else if (ftype === "2") {
    // Consecutive frame
    const nindex = parseInt(line[6], 16);
    if (nindex !== seq + 1) {
      seq = 0;
      remaining = 0;
      return;
    }
    seq = nindex;
    const segment = line.slice(7);
    assemble += segment;
    remaining -= segment.length;
  } else {
    return;
  }

  if (remaining <= 0 && assemble && destPid) {
    if (remaining < 0) {
      assemble = assemble.slice(0, assemble.length + remaining);
    }
    parseAndBroadcast(destPid, assemble);
    assemble = "";
    destPid = "";
    setReady();
  }
}

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
    return new Promise<void>((resolve) => {
      port!.close(() => {
        port = null;
        ready = false;
        testerPresentHandle = null;
        resolve();
      });
    });
  }
  port = null;
  testerPresentHandle = null;
}

function writeln(data: string) {
  if (port && port.isOpen) {
    console.log(`[serial tx] "${data}"`);
    port.write(data + "\r\n");
  } else {
    console.warn(`[serial tx] port not open, dropping: "${data}"`);
  }
}

function buildCmd(pidStr: string): string[] {
  const parts = pidStr.split("-");
  const ecu = parts[0];
  const pid = parts[1];

  // Always send full flow control setup between PID requests.
  // Skipping setup for same-ECU requests causes failures after multi-frame responses.
  const cmds: string[] = [];
  cmds.push("STCFCPC");
  cmds.push("STCFCPA 6F1 " + ecu + ", 6" + ecu + " F1");
  cmds.push("STCAF 1, " + ecu);
  cmds.push("ATCRA6" + ecu);
  cmds.push("22" + pid);
  return cmds;
}

async function sendNextCmd(cmds: string[]) {
  for (let i = 0; i < cmds.length; i++) {
    writeln(cmds[i]);
    if (i < cmds.length - 1) {
      await waitReady(500);
    }
  }
}

async function initSerial(path: string) {
  port = new SerialPort({ path, baudRate: BAUD_RATE });

  const parser = port.pipe(
    new ReadlineParser({ delimiter: "\r" })
  );

  let rawByteCount = 0;
  port.on("data", (buf: Buffer) => {
    const prev = rawByteCount;
    rawByteCount += buf.length;
    if (prev === 0) {
      console.log("[serial] first raw bytes received");
    }
  });

  parser.on("data", (line: string) => {
    let trimmed = line.trim().replace(/[^\x20-\x7E]/g, "");
    if (!trimmed) {
      setReady();
      return;
    }
    if (trimmed.startsWith(">")) trimmed = trimmed.slice(1);
    if (!trimmed) {
      setReady();
      return;
    }
    console.log(`[serial rx] "${trimmed}"`);
    if (initResponseCallback) {
      initResponseCallback(trimmed);
      setReady();
      return;
    }
    if (isTerminalResponse(trimmed)) {
      setReady();
      return;
    }
    processFrame(trimmed);
  });

  port.on("open", async () => {
    console.log(`Serial port ${path} opened`);
    await runInit();
    startPolling();
  });

  port.on("error", (err) => {
    console.error("Serial error:", err.message);
  });

  port.on("close", () => {
    console.log("Serial port closed");
    port = null;
    broadcastPortList();
  });
}

async function runInit() {
  console.log(`[init] starting, ${INIT_CMDS.length} commands to send`);
  for (let i = 0; i < INIT_CMDS.length; i++) {
    console.log(`[init] [${i + 1}/${INIT_CMDS.length}] sending: ${INIT_CMDS[i]}`);
    writeln(INIT_CMDS[i]);
    await waitReady(2000);
  }
  console.log("[relay] Init complete");

  // Clear any lingering periodic messages from prior sessions
  for (let h = 1; h <= 20; h++) {
    writeln(`STPPMC ${h.toString(16).toUpperCase()}`);
    await waitReady(200);
  }
  console.log("[relay] Cleared old periodic message handles");

  // Open Extended Diagnostic Session with BDC gateway
  console.log("[relay] BDC gateway activation...");
  for (const cmd of BDC_SETUP_CMDS) {
    writeln(cmd);
    await waitReady(2000);
  }
  const sessionResp = await sendAndCapture("1003", 3000);
  if (sessionResp.includes("5003")) {
    console.log("[relay] BDC Extended Diagnostic Session opened");
  } else if (sessionResp === "" || sessionResp.includes("NO DATA")) {
    console.warn("[relay] BDC did not respond — session not opened");
  } else if (sessionResp.includes("7F")) {
    console.warn(`[relay] BDC rejected session with NRC: ${sessionResp}`);
  } else {
    console.log(`[relay] BDC session response: ${sessionResp}`);
  }

  // Periodic TesterPresent keeps the BDC session alive between polls
  const tpResp = await sendAndCapture(
    `STPPMA ${TESTER_PRESENT_INTERVAL_MS}, 6F1, 3E80`,
    2000,
  );
  if (tpResp && tpResp.trim()) {
    testerPresentHandle = tpResp.trim();
    console.log(`[relay] TesterPresent registered (handle ${testerPresentHandle})`);
  } else {
    console.warn("[relay] TesterPresent failed to register");
  }

  // Reset addressing — the poller sets its own per-ECU addressing
  writeln("STCAF 0");
  await waitReady(2000);
  writeln("STFA");
  await waitReady(2000);
}

function waitReady(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    ready = false;
    const start = Date.now();
    const check = () => {
      if (ready) {
        console.log(`${Date.now()} [waitReady] got ready in ${Date.now() - start}ms`);
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        console.warn(`[waitReady] TIMEOUT after ${timeout}ms`);
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

function startPolling() {
  const lastPolled = new Map<string, number>();

  console.log(`[poller] startPolling called, pollInterval=${pollInterval}ms`);

  const tick = async () => {
    if (!port || !port.isOpen) {
      console.warn("[poller] port not open, stopping poll loop");
      return;
    }

    const now = Date.now();
    let nextEntry: PidEntry | null = null;
    let maxOverdue = -1;

    for (const entry of PID_TABLE) {
      const elapsed = now - (lastPolled.get(entry.pid) ?? 0);
      const overdue = elapsed - SPEED_INTERVALS[entry.speed];
      if (overdue >= 0 && overdue > maxOverdue) {
        maxOverdue = overdue;
        nextEntry = entry;
      }
    }

    if (nextEntry) {
      lastPolled.set(nextEntry.pid, now);
      console.log(`[poller] polling ${nextEntry.key} (${nextEntry.pid})`);
      const cmds = buildCmd(nextEntry.pid);
      await sendNextCmd(cmds);
      await waitReady(500);
    }

    setTimeout(tick, pollInterval);
  };

  tick();
}

// WebSocket handling
wss.on("connection", async (ws) => {
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  const ports = await listSerialPorts();
  ws.send(JSON.stringify({
    type: "serial_ports",
    ports,
    connected: port?.isOpen ? port.path : null,
  }));

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "set_poll_interval" && typeof data.value === "number") {
        pollInterval = data.value;
        broadcast({ type: "poll_interval", value: pollInterval });
      } else if (data.type === "list_ports") {
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
      }
    } catch {}
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — reset adapter state so it stops transmitting
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[relay] Shutting down...");

  if (portScanTimer) clearInterval(portScanTimer);

  if (port && port.isOpen) {
    if (testerPresentHandle) {
      writeln(`STPPMC ${testerPresentHandle}`);
      await waitReady(1000);
      testerPresentHandle = null;
    }
    writeln("STPC");
    await waitReady(1000);
    writeln("ATD");
    await waitReady(1000);

    await new Promise<void>((resolve) => {
      port!.close(() => resolve());
    });
    console.log("[relay] Serial port closed, adapter reset");
  }

  wss.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown().catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown().catch(() => process.exit(1));
});

async function main() {
  console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);
  console.log("Waiting for device selection from UI...");

  portScanTimer = setInterval(async () => {
    if (clients.size > 0) await broadcastPortList();
  }, 3000);
}

main();
