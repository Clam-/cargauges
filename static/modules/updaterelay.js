var URL = "http://127.0.0.1:8068/data";

function postData(key, data) {
  fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({[key]:data}),
  }).catch(err => { console.log("POST FAIL: " + err)});
}
function batteryupdate(data) {
  postData("batt", data)
}

function rangeupdate(data) {
  postData("range", data)
}

function accelupdate(data) {
  postData("accel", data)
}

function brakeupdate(data) {
  postData("brake", data)
}

function speedupdate(data) {
  postData("speed", data)
}

function steerupdate(data) {
  postData("steer", data)
}

function powerupdate(data, extra) {
  postData("power", [data, extra])
}
function gearupdate(data, extra) {
  postData("gear", data)
}

function acupdate(data) {
  postData("ac", data)
}
function acouttempupdate(data) {
  postData("acout", data)
}
function acintempupdate(data) {
  postData("acin", data)
}
function acsettempupdate(data) {
  postData("acset", data)
}
