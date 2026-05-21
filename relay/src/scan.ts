import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

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

interface ScanPid {
  ecu: string;
  ecuName: string;
  pid: string;
  description: string;
  parse?: (data: string) => string;
}

// Candidates to scan — grouped by category
const SCAN_PIDS: ScanPid[] = [
  // --- CLIMATE (IHX, ECU 78) ---
  { ecu: "78", ecuName: "IHX", pid: "D92C", description: "AC on/off (KLIMA_VORN_OFF_EIN)" },
  { ecu: "78", ecuName: "IHX", pid: "D85C", description: "Cabin temp calculated (TEMP_INNEN_UNBELUEFTET)",
    parse: (d) => `${parseInt(d.slice(0, 2), 16) - 128} °C (signed char)` },
  { ecu: "78", ecuName: "IHX", pid: "D859", description: "Interior temp sensor raw" },
  { ecu: "78", ecuName: "IHX", pid: "D977", description: "Set temperature L/R (SOLLTEMP)",
    parse: (d) => `L=${parseInt(d.slice(0, 2), 16) / 2}°C R=${parseInt(d.slice(2, 4), 16) / 2}°C` },
  { ecu: "78", ecuName: "IHX", pid: "D930", description: "Auto recirc (AUC)" },
  { ecu: "78", ecuName: "IHX", pid: "D931", description: "Recirc (UMLUFT)" },
  { ecu: "78", ecuName: "IHX", pid: "D934", description: "Fan speed front" },
  { ecu: "78", ecuName: "IHX", pid: "D936", description: "Compressor PWM" },
  { ecu: "78", ecuName: "IHX", pid: "D92D", description: "Defrost status" },
  { ecu: "78", ecuName: "IHX", pid: "D92E", description: "Max AC status" },
  { ecu: "78", ecuName: "IHX", pid: "D939", description: "Seat heating left status" },
  { ecu: "78", ecuName: "IHX", pid: "D941", description: "Seat heating right status" },
  { ecu: "78", ecuName: "IHX", pid: "D95C", description: "Heater output %" },
  { ecu: "78", ecuName: "IHX", pid: "D960", description: "Evaporator temp" },
  { ecu: "78", ecuName: "IHX", pid: "D968", description: "Coolant temp" },
  { ecu: "78", ecuName: "IHX", pid: "D978", description: "Climate mode / ventilation" },
  { ecu: "78", ecuName: "IHX", pid: "D9AC", description: "Solar sensor" },

  // --- BRAKES / DSC (ECU 29) ---
  { ecu: "29", ecuName: "DSC", pid: "DC6F", description: "Parking brake status (PBRK)",
    parse: (d) => `status=${parseInt(d.slice(0, 2), 16)} qualifier=${parseInt(d.slice(2, 4), 16)}` },
  { ecu: "29", ecuName: "DSC", pid: "DBF5", description: "Brake pedal travel sensor (mm)",
    parse: (d) => {
      let v = parseInt(d.slice(0, 4), 16);
      if (v & 0x8000) v -= 0x10000;
      return `${v / 100} mm`;
    }},
  { ecu: "29", ecuName: "DSC", pid: "D0D2", description: "Pedal travel sensor alt (mm)" },
  { ecu: "29", ecuName: "DSC", pid: "D272", description: "Wheel speeds" },
  { ecu: "29", ecuName: "DSC", pid: "D62E", description: "Yaw rate / lateral accel" },
  { ecu: "29", ecuName: "DSC", pid: "D6D6", description: "Longitudinal accel" },

  // --- AMBIENT / INSTRUMENT CLUSTER (KOM, ECU 60) ---
  { ecu: "60", ecuName: "KOM", pid: "D112", description: "Ambient temp (A_TEMP_WERT)",
    parse: (d) => `display=${parseInt(d.slice(0, 2), 16) / 2 - 40}°C raw=${parseInt(d.slice(2, 4), 16) / 2 - 40}°C` },
  { ecu: "60", ecuName: "KOM", pid: "D111", description: "Range BEV (KOMBI_REICHWEITE)",
    parse: (d) => `${parseInt(d.slice(0, 4), 16) / 10} km` },
  { ecu: "60", ecuName: "KOM", pid: "D10B", description: "Odometer" },
  { ecu: "60", ecuName: "KOM", pid: "D10E", description: "Trip distance" },

  // --- BATTERY / SME (ECU 07) ---
  { ecu: "07", ecuName: "SME", pid: "DDBC", description: "Display SOC / max / min",
    parse: (d) => `SOC=${parseInt(d.slice(0, 4), 16) / 10}% max=${parseInt(d.slice(4, 8), 16) / 10}% min=${parseInt(d.slice(8, 12), 16) / 10}%` },
  { ecu: "07", ecuName: "SME", pid: "DD69", description: "HV current (signed long/100 = A)",
    parse: (d) => {
      let v = parseInt(d.slice(0, 8), 16);
      if (v & 0x80000000) v -= 0x100000000;
      return `${v / 100} A`;
    }},
  { ecu: "07", ecuName: "SME", pid: "DD68", description: "HV voltage (uint/100 = V)",
    parse: (d) => `${parseInt(d.slice(0, 4), 16) / 100} V` },
  { ecu: "07", ecuName: "SME", pid: "DE5C", description: "HV battery temp" },
  { ecu: "07", ecuName: "SME", pid: "DDA1", description: "Cell voltage min/max" },

  // --- DRIVE (EDM, ECU 12) ---
  { ecu: "12", ecuName: "EDM", pid: "DE9C", description: "Pedal value (bytes 4-5 * 0.0625 = %)",
    parse: (d) => `${parseInt(d.slice(8, 12), 16) * 0.0625}%` },
  { ecu: "12", ecuName: "EDM", pid: "DEBA", description: "Motor torque" },
  { ecu: "12", ecuName: "EDM", pid: "DEAC", description: "Motor RPM" },
  { ecu: "12", ecuName: "EDM", pid: "DEB5", description: "Motor temperature" },

  // --- BDC (ECU 40) ---
  { ecu: "40", ecuName: "BDC", pid: "DABD", description: "Speed / brake status",
    parse: (d) => `speed=${parseInt(d.slice(0, 4), 16) / 64} km/h brake_status=${parseInt(d.slice(6, 8), 16)}` },
  { ecu: "40", ecuName: "BDC", pid: "D550", description: "Light switch status" },
  { ecu: "40", ecuName: "BDC", pid: "DA87", description: "Door lock status" },
  { ecu: "40", ecuName: "BDC", pid: "DCDD", description: "Door/hood open status" },
  { ecu: "40", ecuName: "BDC", pid: "D4F9", description: "Window positions" },

  // --- STEERING (EPS, ECU 30) ---
  { ecu: "30", ecuName: "EPS", pid: "DB57", description: "Pinion angle (signed long / 100 = °)",
    parse: (d) => {
      let v = parseInt(d.slice(0, 8), 16);
      if (v & 0x80000000) v -= 0x100000000;
      return `${v / 100}°`;
    }},

  // --- GEAR (NBT, ECU 63) ---
  { ecu: "63", ecuName: "NBT", pid: "D031", description: "Gear direction",
    parse: (d) => {
      const v = parseInt(d.slice(0, 2), 16);
      return `${v} (${v === 0 ? "R" : v === 1 ? "D" : v === 2 ? "N" : "?"})`;
    }},
];

let port: SerialPort | null = null;
let ready = false;
let responseLines: string[] = [];
let capturing = false;

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
      if (ready) { resolve(); return; }
      if (Date.now() - start > timeout) { resolve(); return; }
      setTimeout(check, 15);
    };
    check();
  });
}

function setReady() { ready = true; }

async function sendCmd(cmd: string, timeout = 500): Promise<string[]> {
  responseLines = [];
  capturing = true;
  writeln(cmd);
  await waitReady(timeout);
  capturing = false;
  return [...responseLines];
}

function parseFrames(lines: string[]): { status: "ok" | "nrc" | "nodata" | "error"; data: string; nrc?: number; raw: string[] } {
  const meaningful = lines.filter(l => !isTerminalResponse(l) && l.length >= 6);
  if (meaningful.length === 0) {
    if (lines.some(l => l === "NO DATA")) return { status: "nodata", data: "", raw: lines };
    return { status: "error", data: "", raw: lines };
  }

  // Check for NRC in any single frame
  for (const line of meaningful) {
    const ftype = line[5];
    if (ftype === "0") {
      const svc = line.slice(7, 9);
      if (svc === "7F") {
        const nrc = parseInt(line.slice(11, 13), 16);
        if (nrc === 0x78) continue; // response pending, keep looking
        return { status: "nrc", data: "", nrc, raw: lines };
      }
    }
  }

  // Assemble data from frames
  let assemble = "";
  let destPid = "";

  for (const line of meaningful) {
    const ftype = line[5];
    if (ftype === "0") {
      if (line.slice(7, 9) !== "62") continue;
      const size = parseInt(line[6], 16);
      destPid = line.slice(9, 13);
      assemble = line.slice(13, 13 + (size - 3) * 2);
    } else if (ftype === "1") {
      if (line.slice(9, 11) !== "62") continue;
      const totalLen = parseInt(line.slice(6, 9), 16);
      destPid = line.slice(11, 15);
      assemble = line.slice(15);
      const remaining = (totalLen - 3) * 2 - assemble.length;
      if (remaining <= 0 && remaining < 0) {
        assemble = assemble.slice(0, assemble.length + remaining);
      }
    } else if (ftype === "2") {
      const segment = line.slice(7);
      assemble += segment;
    }
  }

  if (assemble && destPid) {
    return { status: "ok", data: assemble, raw: lines };
  }
  return { status: "error", data: "", raw: lines };
}

async function openBdcSession() {
  // Setup flow control for BDC
  await sendCmd("STCFCPC");
  await sendCmd("STCFCPA 6F1 40, 640 F1");
  await sendCmd("STCAF 1, 40");
  await sendCmd("ATCRA640");
  const resp = await sendCmd("1003", 3000);
  const joined = resp.join("");
  if (joined.includes("5003")) {
    console.log("  BDC Extended Diagnostic Session: OPENED");
  } else {
    console.log(`  BDC Extended Diagnostic Session: ${resp.join(" | ") || "no response"}`);
  }
  // TesterPresent
  await sendCmd("STPPMA 2000, 6F1, 3E80", 2000);
  // Reset
  await sendCmd("STCAF 0");
  await sendCmd("STFA");
}

async function scanPid(entry: ScanPid): Promise<void> {
  // Setup flow control for this ECU
  await sendCmd("STCFCPC");
  await sendCmd(`STCFCPA 6F1 ${entry.ecu}, 6${entry.ecu} F1`);
  await sendCmd(`STCAF 1, ${entry.ecu}`);
  await sendCmd(`ATCRA6${entry.ecu}`);

  // Send ReadDataByIdentifier
  const resp = await sendCmd(`22${entry.pid}`, 2000);
  const result = parseFrames(resp);

  const prefix = `[${entry.ecuName}:${entry.pid}]`;
  if (result.status === "ok") {
    const parsed = entry.parse ? entry.parse(result.data) : result.data;
    console.log(`  OK    ${prefix} ${entry.description}`);
    console.log(`        data="${result.data}" → ${parsed}`);
  } else if (result.status === "nrc") {
    const nrcNames: Record<number, string> = {
      0x12: "subFunctionNotSupported",
      0x13: "incorrectMessageLength",
      0x14: "responseTooLong",
      0x22: "conditionsNotCorrect",
      0x31: "requestOutOfRange",
      0x33: "securityAccessDenied",
      0x72: "generalProgrammingFailure",
      0x78: "responsePending",
      0x7E: "subFunctionNotSupportedInActiveSession",
      0x7F: "serviceNotSupportedInActiveSession",
    };
    const name = nrcNames[result.nrc!] || `0x${result.nrc!.toString(16)}`;
    console.log(`  NRC   ${prefix} ${entry.description} → ${name}`);
  } else if (result.status === "nodata") {
    console.log(`  NONE  ${prefix} ${entry.description} → NO DATA`);
  } else {
    console.log(`  ERR   ${prefix} ${entry.description} → ${resp.join(" | ")}`);
  }
}

async function main() {
  const portPath = process.argv[2];
  if (!portPath) {
    console.log("Usage: npx tsx src/scan.ts <serial-port-path>");
    console.log("Example: npx tsx src/scan.ts /dev/tty.usbserial-113011075587");
    console.log(`\nWill scan ${SCAN_PIDS.length} PIDs across ${new Set(SCAN_PIDS.map(p => p.ecuName)).size} ECUs`);
    console.log("\nPIDs to scan:");
    let lastEcu = "";
    for (const p of SCAN_PIDS) {
      if (p.ecuName !== lastEcu) {
        console.log(`\n  --- ${p.ecuName} (ECU 0x${p.ecu}) ---`);
        lastEcu = p.ecuName;
      }
      console.log(`  ${p.pid}: ${p.description}`);
    }
    process.exit(0);
  }

  console.log(`Opening ${portPath} at ${BAUD_RATE} baud...`);
  port = new SerialPort({ path: portPath, baudRate: BAUD_RATE });

  const parser = port.pipe(new ReadlineParser({ delimiter: "\r" }));

  parser.on("data", (line: string) => {
    let trimmed = line.trim().replace(/[^\x20-\x7E]/g, "");
    if (!trimmed) { setReady(); return; }
    if (trimmed.startsWith(">")) trimmed = trimmed.slice(1);
    if (!trimmed) { setReady(); return; }
    if (capturing) {
      responseLines.push(trimmed);
    }
    if (isTerminalResponse(trimmed)) {
      setReady();
      return;
    }
  });

  await new Promise<void>((resolve) => {
    port!.on("open", resolve);
  });

  console.log("Port opened. Initializing...\n");

  // Init
  for (const cmd of INIT_CMDS) {
    await sendCmd(cmd, 2000);
  }

  // Clear old periodic messages
  for (let h = 1; h <= 20; h++) {
    await sendCmd(`STPPMC ${h.toString(16).toUpperCase()}`, 200);
  }

  console.log("Opening BDC Extended Diagnostic Session...");
  await openBdcSession();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`SCANNING ${SCAN_PIDS.length} PIDs`);
  console.log(`${"=".repeat(70)}\n`);

  let lastEcu = "";
  let okCount = 0;
  let nrcCount = 0;
  let noDataCount = 0;

  for (const entry of SCAN_PIDS) {
    if (entry.ecuName !== lastEcu) {
      console.log(`\n--- ${entry.ecuName} (ECU 0x${entry.ecu}, addr 6${entry.ecu}) ---`);
      lastEcu = entry.ecuName;
    }
    await scanPid(entry);
    const resp = responseLines; // last response from scanPid
    // Simple counting based on console output (rough)
  }

  // Count results from output
  console.log(`\n${"=".repeat(70)}`);
  console.log("SCAN COMPLETE");
  console.log(`${"=".repeat(70)}`);

  // Cleanup
  await sendCmd("STPC");
  await sendCmd("ATD");

  port.close(() => {
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
