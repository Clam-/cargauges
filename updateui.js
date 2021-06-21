function batteryupdate(data) {
  var values = batteryparse(data);
  document.getElementById("bat-percent").innerHTML = values[0];
  document.getElementById("bat-percent-real").innerHTML = values[1];
}

function rangeupdate(data) {
  document.getElementById("range").innerHTML = rangeparse(data);
}

function accelupdate(data) {
  document.gauges.get("accel-gauge").value = accelparse(data);
}

function brakeupdate(data) {
  document.gauges.get("brake-gauge").value = brakeparse(data);
}

function speedupdate(data) {
  document.gauges.get("speed-gauge").value = speedparse(data);
}

function steerupdate(data) {
  document.gauges.get("steer-gauge").value = steerparse(data);
}

function powerupdate(data) {
  document.gauges.get("power-gauge").value = powerparse(data);
}

function acupdate(data) {
  document.getElementById("ac-status").value = acparse(data) ? "Off" : "On";
}
function acouttempupdate(data) {
  document.getElementById("ac-out").innerHTML = acouttempparse(data).toFixed(1);
}
function acintempupdate(data) {
  document.getElementById("ac-in").innerHTML = acintempparse(data).toFixed(1);
}
function acsettempupdate(data) {
  document.getElementById("ac-set").innerHTML = acsettempparse(data).toFixed(0);
}
