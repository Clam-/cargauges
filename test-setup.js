
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
