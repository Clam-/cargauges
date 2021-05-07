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


async function testPort(p) {
  return true;
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


async function init(gauges) {
  var port = null;
  while (port === null) {
    port = getPort();
    await sleep(2000);
  }
  if (port) {
    // comms please.
    await port.open({ baudRate: 9600 });

    // setup read
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable
      .pipeThrough(new TransformStream(new LineBreakTransformer()))
      .getReader();
    // setup write:
    const writer = port.writable.getWriter();

      // Listen to data coming from the serial device.
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock();
        break;
      }
      // value is a string.
      console.log(value);
      // write something:
      // const data = new Uint8Array([104, 101, 108, 108, 111]); // hello
      // await writer.write(data);
    }

    const textEncoder = new TextEncoderStream();
    const writableStreamClosed = textEncoder.readable.pipeTo(port.writable);

    reader.cancel();
    await readableStreamClosed.catch(() => { /* Ignore the error */ });
    // Allow the serial port to be closed later.
    writer.releaseLock();
    writer.close();
    await writableStreamClosed;

    await port.close();
  }
}
