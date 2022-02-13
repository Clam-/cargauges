import * as ui from './modules/updateui.js';
import * as odb from './modules/obdpoller.js';

function doGauges(isClick) {
  odb.datastart(isClick, ui)
}

window.addEventListener('load', () => { doGauges(false); });
document.body.addEventListener("click", () => { doGauges(true); })
