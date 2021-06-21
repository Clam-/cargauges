const FAST = 1000;
const MED = 2000;
const SLOW = 5000;
const INITCMDS = [
  "ATD",
  "ATE0",
  "ATH1",
  "ATAL",
  "ATPBE101",
  "ATSPB",
  "ATBI",
  "ATSH6F1",
  "ATCRA607",
  //"ATCF600",
  //"ATCF700",
  "ATCRA607",
  "ATFCSH6F1",
  "ATFCSD07300800",
  "ATFCSM1",

  "ATS0", //don't print spaces
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
class LineBreakTransformer {
  constructor() {
    // A container for holding stream data until a new line.
    this.chunks = "";
  }
  transform(chunk, controller) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // For each line breaks in chunks, send the parsed lines out.
    const lines = this.chunks.split("\r\n");
    this.chunks = lines.pop();
    lines.forEach((line) => controller.enqueue(line));
  }
  flush(controller) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}

class FancyPort {
  constructor(p) {
    this.port = p;
    this.done = false;
  }
  async open() {
    await p.open({ baudRate: 115200 });
    // setup read
    const textDecoder = new TextDecoderStream();
    this.readableStreamClosed = p.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable
      .pipeThrough(new TransformStream(new LineBreakTransformer()))
      .getReader();
    // setup write:
    const textEncoder = new TextEncoderStream();
    this.writableStreamClosed = textEncoder.readable.pipeTo(port.writable);
    this.writer = textEncoder.writable.getWriter();
    this.write = this.writer.write
  }
  async initcomms() {
    // do weird BMW setup stuff...
    for (var i in INITCMDS) {
      console.log("SENDING: " + i);
      this.writeln(i);
      var value = await this.read();
      if (this.done) { return false; }
    }
    this.ready = true;
    return true;
  }
  async writeln(s) { return this.writer.write(s+"\n"); }
  async read() {
    const { value, done } = await this.reader.read();
    this.done = done;
    return value;
  }
  async close() {
    this.reader.releaseLock()
    this.reader.cancel();
    await this.readableStreamClosed.catch(() => { /* Ignore the error */ });
    // Allow the serial port to be closed later.
    this.writer.releaseLock();
    this.writer.close();
    await this.writableStreamClosed;
    await this.port.close();
  }
  async test() {
    await this.writeln("ATSP0")
    const value = await this.read();
    this.close();
    if (value == "OK") { return true; }
    else { return false; }
  }
  async sendpid(pid) {
    return this.writeln("070322"+pid)
  }
}

async function getPort(isClick) {
  // attempt on any previous ports
  const ports = await navigator.serial.getPorts();
  var fancyp = null;
  ports.forEach(async (p)=>{
    fancyp = new FancyPort(p)
    await fancyp.open();
    if (await fancyp.test()) {return fancyp};
  });
  // if fail, prompt for port
  if (isClick) {
    fancyp = new(await navigator.serial.requestPort());
    await fancyp.open();
    if (await fancyp.test()) {return fancyp};
  }
  return null;
}

async function recvdispatch(pid, value, recvmap, prevmap) {
  var mapping = recvmap[pid];
  var moredata = [];
  for (const key of mapping[1]) { moredata.push(prevmap[key]); }
  for (const fn of mapping[0]) {
    fn(value, moredata);
  }
}

async function recvloop(fancyport, recvmap) {
  // recvmap = {PID: [[list of func], [list of other PIDs to include...]]}
  var assemble = "";
  var dest = ""; // PID
  var remaining = 0;
  var seq = 0;
  var curframe = null;
  var prevmap = {} // PID : value
  while (!fancyport.done) {
    // process data...
    curframe = fancyport.read()
    // is this first frame?
    var ftype = curframe[5]  // 0 single, 1 first, 2 consec
    if (ftype == "0") {
      // ignore pending
      if (curframe.slice(7,9) != "62") { continue; } // abort if not service reply
      remaining = parseInt(curframe[6], 16);
      dest = curframe.slice(9,13);
      assemble = curframe.slice(7, 7+((remaining - 3)*2)); // slice up to size of frame minus the 3 header bytes
      // assemble ready for processing...
    } else if (ftype == "1") {
      if (curframe.slice(9,11) != "62") { continue; } // abort if not service reply
      remaining = parseInt(curframe.slice(7, 9), 16);
      dest = curframe.slice(11,15);
      assemble = curframe.slice(15);
      seq = 0;
      remaining = (remaining - 5)*2; // 5 bytes maximum for first packet convert to hex chars(*2)
    } else if (ftype == "2") {
      var nindex = parseInt(curframe[6]);
      if (nindex != seq+1) { seq=0; explodeeverything; } // abort because sequence out of order. I'm not sure how to recover from this yet...
      seq = nindex;
      var segment = curframe.slice(7,7+remaining);
      assemble += segment;
      remaining -= segment.length;
    }
    if (remaining == 0) {
      // assemble ready for processing...
      recvdispatch(dest, assemble, recvmap, prevmap)
      prevmap[dest] = assemble;
      fancyport.ready = true;
    }
  }
}

async function sendloop(fancyport, speedmapping){
  var queue = new Set();
  var item = null;
  while (!fancyport.done) {
    var tnow = performance.now(); // lol does "DOMHighResTimeStamp" overflow/rollover ??
    var tfast = performance.now();
    var tmed  = performance.now();
    var tslow = performance.now();
    if (tnow - tfast >= FAST) {
      for (const pid in speedmapping["fast"]) { queue.add(pid) }
      tfast = tnow;
    } else if (tnow - tmed >= MED) {
      for (const pid in speedmapping["med"]) { queue.add(pid) }
      tmed = tnow;
    } else if (tnow - tslow >= SLOW) {
      for (const pid in speedmapping["slow"]) { queue.add(pid) }
      tslow = tnow;
    }
    if (fancyport.ready) {
      item = queue.values().next()
      if (item) {
        // process
        queue.delete(item);
        fancyport.sendpid(pid);
        fancyport.ready = false;
      } else { await new Promise(r => setTimeout(r, 50)); } // sleep a lil...
    } else { await new Promise(r => setTimeout(r, 50)); } // sleep a lil...
  }
}

function get(object, key, default_value) {
    var result = object[key];
    return (typeof result !== "undefined") ? result : default_value;
}
function setupmap(source) {
  var recvmap = {}; // recvmap = {PID: [[list of func, [list of other PIDs to include...]]}
  var sendmap = {"fast": new Set(), "med": new Set(), "slow": new Set() };
  for (const [speed, name, func, pids] of source) {
    for (const ipid of pids) {
      sendmap[speed].add(pid);
    }
    // last item of the list of PIDs
    var pid = pids[pids.length-1];
    var mapping = get(recvmap, pid, []);
    mapping.push([func,[pids.slice(0,-1)]]) // don't include mapping pid in the extras
    recvmap[pid] = mapping; // yeah I know reassign thing that may already be assigned, but whatever...
  }
  return [recvmap, sendmap];
}

async function datastart(isClick, speedstruct) {
  var [recvmap, sendmap] = setupmap(speedstruct);
  var fancyport = null;
  while (fancyport === null) {
    fancyport = await getPort(isClick);
    await sleep(500);
  }
  if (fancyport) {
    // comms please.
    var setupstatus = await fancyport.initcomms();
    if (!setupstatus) { return; }
    // Data loop
    recvloop(fancyport, recvmap);
    sendloop(fancyport, sendmap);
    // wait for done... I guess?
    while (!fancyport.done) {
      await new Promise(r => setTimeout(r, 1000)); // sleep a bit...
    }
    await fancyport.close();
  }
}
