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

// once every 5 cycles
const SLOWUPDATE = [battery, range];
// once every 3 cycles
const MEDUPDATE = [steer, brake];
// once every cycle
const FASTUPDATE = [reqAndSetSpeed, reqAndSetAccel, power];

async function dataloop(fancyport, gauges) {
  var done = false;
  while (!done) {
    [reqAndSetSpeed, reqAndSetAccel].forEach((func) => {
      done = func(fancyport, gauges);
    });

    done = reqAndSetSpeed(fancyport, gauges);
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
