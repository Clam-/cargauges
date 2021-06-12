
// once every 5 seconds
const SLOWUPDATE = [];
// once every second
const MEDUPDATE = [];
// once every 100ms
const FASTUPDATE = [];

// Stolen from here: https://github.com/nickn17/evDash/blob/master/src/CarBmwI3.cpp
// and here: https://forum.abetterrouteplanner.com/topic/317-decoding-the-i3s-pids/?do=findComment&comment=6829
const INITCMDS = [
  "ATZ", "ATD",
  "ATE0",
  "ATPP2COFF",
  "ATCF600",
  "ATCF700",
  "ATPBC001",
  "ATSPB",
  "ATAT0",
  "ATSTFF",
  "ATAL",
  "ATH1",
  "ATS0",
  "ATL0",
  "ATCSM0",
  "ATCTM5",
  "ATJE",
  "ATSH6F1",
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
async function setupPort(p) {
  const fancyport = { port: p };
  await p.open({ baudRate: 9600 });
  // setup read
  const textDecoder = new TextDecoderStream();
  fancyport.readableStreamClosed = p.readable.pipeTo(textDecoder.writable);
  fancyport.reader = textDecoder.readable
    .pipeThrough(new TransformStream(new LineBreakTransformer()))
    .getReader();
  // setup write:
  const textEncoder = new TextEncoderStream();
  fancyport.writableStreamClosed = textEncoder.readable.pipeTo(port.writable);
  fancyport.writer = textEncoder.writable.getWriter();
  fancyport.write = fancyport.writer.write
  fancyport.writeln = (s) => { fancyport.writer.write(s+"\n"); }
  fancyport.read = fancyport.reader.read
  return fancyport;
}
async function setupstage2(fancyp){
  // do weird BMW setup stuff...
  await fancyp.writeln("");
  const { value, done } = await fancyport.read();

}
async function closePort(fancyp) {
  fancyp.reader.releaseLock()
  fancyp.reader.cancel();
  await fancyp.readableStreamClosed.catch(() => { /* Ignore the error */ });
  // Allow the serial port to be closed later.
  fancyp.writer.releaseLock();
  fancyp.writer.close();
  await fancyp.writableStreamClosed;
  await fancyp.port.close();
}

async function testPort(p) {
  const fancyport = setupPort(p);
  await fancyport.writeln("ATSP0")
  const { value, done } = await fancyport.read();
  closePort(fancyport);
  if (value == "OK") { return true; }
  else { return false; }
}

async function getPort(){
  // attempt on any previous ports
  const ports = await navigator.serial.getPorts();
  ports.foreach((p)=>{
    if (testPort(p)) {return p};
  });
  // if fail, prompt for port
  const port = await navigator.serial.requestPort();
  return port;
}

async function reqAndSetSpeed(fancyp, gauges) {
  await fancyp.writeln("010D");
  const { value, done } = await fancyp.read();
  console.log("speed: " + value);
  gauges["speed"].value = value;
  return done;
}
async function reqAndSetAccel(fancyp, gauges) {
  await fancyp.writeln("010D");
  const { value, done } = await fancyp.read();
  console.log("accel: " + value);
  gauges["speed"].value = value;
  return done;
}

// build codestring, then get number of responses of lenth of codes...
async function doUpdate(type, fancyp, gauges) {
  if (type.length > 0) {
    await fancyp.writeln("" + type.join(" "));
    const { value, done } = await fancyport.read();
    if (value) {
      // get multiple responses or split response, dunno yet... and assign them to the gauge that matches the index of type
      type[index]

      gauges[type[index]].value = ;
    }
    return done;
  }
}

async function dataloop(fancyport, gauges) {
  var done = false;
  var tfast = performance.now();
  var tmed  = performance.now();
  var tslow = performance.now();
  while (!done) {
    var tnow = performance.now();
    // lol does "DOMHighResTimeStamp" overflow/rollover ??
    if (tnow - tfast >= 100) {
      done = doUpdate(FASTUPDATE, fancyp, gauges)
      tfast = tnow;
    } else if (tnow - tmed >= 1000) {
      done = doUpdate(MEDUPDATE, fancyport, gauges)
      tmed = tnow;
    } else if (tnow - tslow >= 5000) {
      done = doUpdate(SLOWUPDATE, fancyport, gauges)
      tslow = tnow;
    }
  }
}

async function init(gauges) {
  var port = null;
  while (port === null) {
    port = getPort();
    await sleep(500);
  }
  if (port) {
    // comms please.
    const fancyport = setupPort(port);

    // Data loop
    dataloop(fancyport, gauges);

    closePort(fancyport);
  }
}
