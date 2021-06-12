function batteryupdate(perc) {
  document.getElementById("bat-percent").innerHTML = perc;
}
function rangeupdate(range) {
  document.getElementById("range").innerHTML = range;
}
function accelupdate(range) {
  document.gauges.get("accel-gauge").value = range;
}
function brakeupdate(range) {
  document.gauges.get("brake-gauge").value = range;
}
function speedupdate(range) {
  document.gauges.get("speed-gauge").value = range;
}
function steerupdate(range) {
  document.gauges.get("steer-gauge").value = range;
}
function powerupdate(range) {
  document.gauges.get("power-gauge").value = range;
}

function doGauges() {
  // document.gauges.get("speed-gauge").update({
  //   colorNeedle: "#20105c",
  //   colorNeedleEnd: '#432d96'
  // });
  // init data, and give gauge objcs, and func of batt
  // "updatespeed": [["type",updatefunc,sendcode]]
  init({
    "fast": [
      ["accel", accelupdate, ""]
      ["brake", brakeupdate, ""]
      ["speed", speedupdate, ""]
      ["steer", steerupdate, ""]
      ["power", powerupdate; ""]
    ],
    "medium": [],
    "slow": [
      ["battery", batteryupdate,""]
      ["range", rangeupdate,""]
    ]
  })
}

var script = document.querySelector('#gjs');
script.addEventListener('load', function() {
  doGauges();
});
