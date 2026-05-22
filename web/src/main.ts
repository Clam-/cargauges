interface GaugeDocument extends Document {
  gauges: Map<string, { value: number }>;
}

const gaugeDoc = document as unknown as GaugeDocument;
const WS_URL = `ws://${window.location.hostname}:8069`;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastMessageAt = 0;
let staleTicker: ReturnType<typeof setInterval> | null = null;
const STALE_TIMEOUT = 3000;

const statusDot = document.getElementById("ws-status")!;
const pollSelect = document.getElementById("poll-speed") as HTMLSelectElement;
const serialSelect = document.getElementById("serial-device") as HTMLSelectElement;
const accelOverlay = document.getElementById("accel-value")!;

function setStatus(connected: boolean) {
  statusDot.className = connected
    ? "status-dot connected"
    : "status-dot disconnected";
}

function connect() {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus(true);
    lastMessageAt = Date.now();
    if (staleTicker) clearInterval(staleTicker);
    staleTicker = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_TIMEOUT) {
        console.warn(`[ws] no data for ${STALE_TIMEOUT}ms, forcing reconnect`);
        connect();
      }
    }, 2000);
    const interval = parseInt(pollSelect.value, 10);
    ws!.send(JSON.stringify({ type: "set_poll_interval", value: interval }));
  };

  ws.onclose = () => {
    setStatus(false);
    if (staleTicker) { clearInterval(staleTicker); staleTicker = null; }
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "serial_ports") {
        handleSerialPorts(data);
      } else {
        handleData(data);
      }
    } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 500);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" &&
      (!ws || ws.readyState !== WebSocket.OPEN)) {
    connect();
  }
});

function handleSerialPorts(data: { ports: { path: string; manufacturer?: string }[]; connected: string | null }) {
  const current = serialSelect.value;
  while (serialSelect.options.length > 1) serialSelect.remove(1);

  for (const p of data.ports) {
    const opt = document.createElement("option");
    opt.value = p.path;
    opt.textContent = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
    serialSelect.appendChild(opt);
  }

  if (data.connected) {
    serialSelect.value = data.connected;
  } else if (current && data.ports.some((p) => p.path === current)) {
    serialSelect.value = current;
  } else {
    serialSelect.value = "";
  }
}

function handleData(data: Record<string, unknown>) {
  if (data.accel !== undefined) {
    const v = data.accel as number;
    gaugeDoc.gauges.get("accel-gauge")!.value = v;
    accelOverlay.textContent = v.toFixed(1);
  }
  if (data.brake !== undefined) {
    gaugeDoc.gauges.get("brake-gauge")!.value = data.brake as number;
  }
  if (data.speed !== undefined) {
    gaugeDoc.gauges.get("speed-gauge")!.value = data.speed as number;
  }
  if (data.steer !== undefined) {
    gaugeDoc.gauges.get("steer-gauge")!.value = data.steer as number;
  }
  if (data.power !== undefined) {
    gaugeDoc.gauges.get("power-gauge")!.value = data.power as number;
  }
  if (data.batt !== undefined) {
    const [b1, b2] = data.batt as number[];
    document.getElementById("bat-percent")!.textContent = b1.toFixed(1);
    document.getElementById("bat-percent-real")!.textContent = b2.toFixed(1);
  }
  if (data.range !== undefined) {
    document.getElementById("range")!.textContent = (data.range as number).toFixed(0);
  }
  if (data.ac !== undefined) {
    const val = data.ac as number;
    document.getElementById("ac-status")!.textContent = val ? "Off" : "On";
  }
  if (data.acout !== undefined) {
    document.getElementById("ac-out")!.textContent = (data.acout as number).toFixed(1);
  }
  if (data.acin !== undefined) {
    document.getElementById("ac-in")!.textContent = (data.acin as number).toFixed(1);
  }
  if (data.acset !== undefined) {
    document.getElementById("ac-set")!.textContent = (data.acset as number).toFixed(0);
  }
  if (data.gear !== undefined) {
    document.getElementById("gear")!.textContent = data.gear as string;
  }
}

pollSelect.addEventListener("change", () => {
  const interval = parseInt(pollSelect.value, 10);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "set_poll_interval", value: interval }));
  }
});

serialSelect.addEventListener("change", () => {
  const path = serialSelect.value || null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "select_port", path }));
  }
});

window.addEventListener("load", () => {
  connect();
});
