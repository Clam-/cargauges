import * as dp from './dataparser.js';

function batteryupdate(data) {
  var values = dp.batteryparse(data);
  document.getElementById("bat-percent").innerHTML = values[0];
  document.getElementById("bat-percent-real").innerHTML = values[1];
}

function rangeupdate(data) {
  document.getElementById("range").innerHTML = dp.rangeparse(data);
}

function accelupdate(data) {
  document.gauges.get("accel-gauge").value = dp.accelparse(data);
}

function brakeupdate(data) {
  document.gauges.get("brake-gauge").value = dp.brakeparse(data);
}

function speedupdate(data) {
  document.gauges.get("speed-gauge").value = dp.speedparse(data);
}

function steerupdate(data) {
  document.gauges.get("steer-gauge").value = dp.steerparse(data);
}

function powerupdate(data, extra) {
  document.gauges.get("power-gauge").value = dp.powerparse(data, extra);
}
function gearupdate(data) {
  document.getElementById("gear").innerHTML = data;
}

function acupdate(data) {
  document.getElementById("ac-status").innerHTML = dp.acparse(data) ? "Off" : "On";
}
function acouttempupdate(data) {
  document.getElementById("ac-out").innerHTML = dp.acouttempparse(data).toFixed(1);
}
function acintempupdate(data) {
  document.getElementById("ac-in").innerHTML = dp.acintempparse(data).toFixed(1);
}
function acsettempupdate(data) {
  document.getElementById("ac-set").innerHTML = dp.acsettempparse(data).toFixed(0);
}
