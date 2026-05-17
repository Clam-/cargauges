import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocketServer, WebSocket } from "ws";

const WS_PORT = 8069;
const BAUD_RATE = 115200;

const INIT_CMDS = [
  "ATD",
  "ATE0",
  "ATS0",
  "ATH1",
  "ATAL",
  "ATPBE101",
  "ATSPB",
  "ATBI",
  "ATSH6F1",
  "ATCRA607",
  "ATFCSH6F1",
  "ATFCSD07300800",
  "ATFCSM1",
];

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
  { pid: "07-DDBC", speed: "slow", key: "batt" },
  { pid: "07-D111", speed: "slow", key: "range" },
  { pid: "78-D92C", speed: "slow", key: "ac" },
  { pid: "60-D112", speed: "slow", key: "acout" },
  { pid: "78-D859", speed: "slow", key: "acin" },
  { pid: "78-D977", speed: "slow", key: "acset" },
  { pid: "63-D031", speed: "med", key: "gear" },
];

const SPEED_INTERVALS = { fast: 1000, med: 2000, slow: 5000 };

let port: SerialPort | null = null;
let ready = false;
let currentBc = "";
let pollInterval = 250;

const dataStore: Record<string, string> = {};
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set<WebSocket>();

// Multi-frame assembly state
let assemble = "";
let destPid = "";
let remaining = 0;
let seq = 0;

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

function parseAndBroadcast(pid: string, data: string) {
  dataStore[pid] = data;

  const entry = PID_TABLE.find(
    (e) => e.pid.split("-")[1] === pid
  );
  if (!entry) return;

  const result: Record<string, number | string | number[]> = {};

  switch (entry.key) {
    case "accel":
      result.accel = parseInt(data.slice(8), 16) * 0.0625;
      break;
    case "speed": {
      const spd = parseInt(data.slice(0, 4), 16) / 64;
      const brk = parseInt(data.slice(8), 16);
      result.speed = spd;
      result.brake = brk;
      break;
    }
    case "steer":
      result.steer = longParse(data.slice(0, 8));
      break;
    case "power_volts": {
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
      // stored for power_volts calculation
      break;
    case "batt": {
      const b1 = parseInt(data.slice(0, 4), 16) / 10;
      const b2 = parseInt(data.slice(4, 8), 16) / 10;
      result.batt = [b1, b2];
      break;
    }
    case "range":
      result.range = parseInt(data.slice(0, 4), 16) / 10;
      break;
    case "ac":
      result.ac = parseInt(data.slice(0, 2), 16);
      break;
    case "acout":
      result.acout = parseInt(data.slice(0, 2), 16) / 2 - 40;
      break;
    case "acin":
      result.acin = parseInt(data.slice(0, 2), 16);
      break;
    case "acset":
      result.acset = parseInt(data.slice(0, 2), 16) / 2;
      break;
    case "gear":
      result.gear = data;
      break;
  }

  if (Object.keys(result).length > 0) broadcast(result);
}

function processFrame(line: string) {
  if (!line || line.length < 6) return;

  const ftype = line[5];

  if (ftype === "0") {
    // Single frame
    if (line.slice(7, 9) !== "62") return;
    const size = parseInt(line[6], 16);
    destPid = line.slice(9, 13);
    assemble = line.slice(13, 13 + (size - 3) * 2);
    remaining = 0;
  } else if (ftype === "1") {
    // First frame of multi
    if (line.slice(9, 11) !== "62") return;
    const totalLen = parseInt(line.slice(7, 9), 16);
    destPid = line.slice(11, 15);
    assemble = line.slice(15);
    seq = 0;
    remaining = (totalLen - 5) * 2 - assemble.length;
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
    parseAndBroadcast(destPid, assemble);
    assemble = "";
    destPid = "";
  }
}

function writeln(data: string) {
  if (port && port.isOpen) {
    port.write(data + "\r\n");
  }
}

function buildCmd(pidStr: string): string[] {
  const parts = pidStr.split("-");
  const cmds: string[] = [];
  const ecu = parts[0];
  const pid = parts[1];

  if (ecu !== currentBc) {
    cmds.push("ATCEA" + ecu);
    currentBc = ecu;
  }
  cmds.push("22" + pid);
  return cmds;
}

async function sendNextCmd(cmds: string[]) {
  for (const cmd of cmds) {
    writeln(cmd);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function initSerial(path: string) {
  port = new SerialPort({ path, baudRate: BAUD_RATE });

  const parser = port.pipe(
    new ReadlineParser({ delimiter: "\r\n" })
  );

  parser.on("data", (line: string) => {
    const trimmed = line.trim();
    if (trimmed === ">" || trimmed === "OK" || trimmed === "") {
      ready = true;
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
  });
}

async function runInit() {
  for (const cmd of INIT_CMDS) {
    writeln(cmd);
    await waitReady(2000);
  }
  console.log("Init complete");
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

function startPolling() {
  const timers: Record<string, number> = { fast: 0, med: 0, slow: 0 };
  let pidIndex = 0;

  const tick = async () => {
    if (!port || !port.isOpen) return;

    const now = Date.now();
    const pidsToSend: string[] = [];

    for (const speed of ["fast", "med", "slow"] as const) {
      if (now - timers[speed] >= SPEED_INTERVALS[speed]) {
        timers[speed] = now;
        for (const entry of PID_TABLE.filter((e) => e.speed === speed)) {
          pidsToSend.push(entry.pid);
        }
      }
    }

    for (const pid of pidsToSend) {
      const cmds = buildCmd(pid);
      await sendNextCmd(cmds);
      await waitReady(500);
    }

    setTimeout(tick, pollInterval);
  };

  tick();
}

// WebSocket handling
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "set_poll_interval" && typeof data.value === "number") {
        pollInterval = data.value;
        broadcast({ type: "poll_interval", value: pollInterval });
      }
    } catch {}
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });
});

// Find and connect to serial port
async function findPort(): Promise<string | null> {
  const ports = await SerialPort.list();
  // Look for common OBD adapter identifiers
  const obd = ports.find(
    (p) =>
      p.manufacturer?.toLowerCase().includes("ftdi") ||
      p.manufacturer?.toLowerCase().includes("silicon") ||
      p.vendorId === "0403" ||
      p.vendorId === "10C4" ||
      p.path.includes("usbserial") ||
      p.path.includes("usbmodem") ||
      p.path.includes("ttyUSB") ||
      p.path.includes("ttyACM")
  );
  return obd?.path ?? ports[0]?.path ?? null;
}

async function main() {
  console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

  const serialPath = process.argv[2] || (await findPort());
  if (serialPath) {
    console.log(`Connecting to serial port: ${serialPath}`);
    await initSerial(serialPath);
  } else {
    console.log("No serial port found. Waiting for connections...");
    console.log("Pass a port path as argument: pnpm dev /dev/ttyUSB0");
  }
}

main();
