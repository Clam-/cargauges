// notes:
// Speed, brakeped: 22 DABD - trying
//    alt Speed: 22 DBE4 22 D107
//    alt Brakes: 22 D0D2, 22 DBF5
// Accel: 22 DE9C
// steer 22 DB57

// power: 22 DD69 amps * 22 DD68 Voltage
// range: 22 0xD111
// batt: DD BC
// out temp: 0XD112   /2.0f-40.0
//    TEST: 0xD96B    /2 -40
// in temp: 0xD85C  ???valeoff?
//    TEST: 0xD859, D85A, 0xD991
// ac on: 0xD92C  0 = on
// desired temp: 0xD988
//    TEST: D977
//

// CONSIDER D542  for indicator/lights/etc
// GEAR D031

function doGauges(isClick) {
  // init data, and give gauge objcs, and func of batt
  // "updatespeed": [["gauge",updatefunc,[pids]]]
  // ["speed", "gaugename", updatefunc, [pids]]
  datastart(isClick, [
    ["fast", "accel", accelupdate, ["12-DE9C"]],
    ["fast", "brake", brakeupdate, ["40-DABD"]],
    ["fast", "speed", speedupdate, ["40-DABD"]],
    ["fast", "steer", steerupdate, ["30-DB57"]],
    ["fast", "power", powerupdate, ["07-DD69", "07-DD68"]], // only last item will be dispatched
    ["slow", "battery", batteryupdate, ["07-DDBC"]],
    ["slow", "range", acupdate, ["78-D92C"]],
    ["slow", "range", acouttempupdate, ["60-D112"]],
    ["slow", "range", acintempupdate, ["78-D859"]],
    ["slow", "range", acsettempupdate, ["78-D977"]],
    ["med", "gear", gearupdate, ["63-D031"]],
  ])
}

window.addEventListener('load', () => { doGauges(false); });
document.body.addEventListener("click", () => { doGauges(true); })
