function batteryupdate(perc) {
  document.getElementById("bat-percent").innerHTML = perc;
}
function rangeupdate(range) {
  document.getElementById("range").innerHTML = range;
}

function doGauges() {
  // init data, and give gauge objcs, and func of batt
  // document.gauges.get("speed-gauge").update({
  //   colorNeedle: "#20105c",
  //   colorNeedleEnd: '#432d96'
  // });
  initdata({
    battery: batteryupdate,
    range: rangeupdate,
    accel: document.gauges.get("accel-gauge"),
    brake: document.gauges.get("brake-gauge"),
    speed: document.gauges.get("speed-gauge"),
    steer: document.gauges.get("steer-gauge"),
  })
}

var script = document.querySelector('#gjs');
script.addEventListener('load', function() {
  doGauges();
});
