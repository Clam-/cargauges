import * as odb from './modules/obdpoller.js';
import * as ur from './modules/updaterelay.js';

function doGauges(isClick) {
  // ["speed", "gaugename", updatefunc, [pids]]
  datastart(isClick, ur);
}

window.addEventListener('load', () => { doGauges(false); });
document.body.addEventListener("click", () => { doGauges(true); })
