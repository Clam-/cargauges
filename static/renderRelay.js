import * as ui from './modules/updateui.js';

async function* poller(url) {
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  // the actual individual poll
  async function pollerFunc(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) {
      return response.json();
    } else {
      Promise.reject(response);
    }
  }
  while (true) {
    try {
      await sleep(100);
      const value = await pollerFunc(url);
      yield value;
    } catch (reason) {
      console.log("Error happen?"+reason)
    }
  }
}

FUNCMAP = {
  "accel": ui.accelupdate,
  "brake": ui.brakeupdate,
  "speed": ui.speedupdate,
  "steer", ui.steerupdate,
  "power", (data) => {ui.powerupdate(data[0], data[1]);},
  "batt", ui.batteryupdate,
  "range", ui.rangeupdate,
  "ac", ui.acupdate,
  "acout", ui.acouttempupdate,
  "acin", ui.acintempupdate,
  "acset", ui.acsettempupdate,
  "gear", ui.gearupdate
}

function doGauges() {
  for await (const dict of poller()) {
    for (const [key, value] of Object.entries(dict)) {
      FUNCMAP[key](value);
    }
  }
}


window.addEventListener('load', () => { doGauges(); });
