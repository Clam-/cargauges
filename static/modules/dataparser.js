function long(data) {
  var d = parseInt(data,16);
  if ((d & 0x80000000) > 0) { d = d - 0x100000000; }
  return d;
}

export function batteryparse(data) {
  // 039F 03A6 0073
  var batt1 = parseInt(data.splice(0,4),16) /10;
  var batt2 = parseInt(data.splice(4,8),16) /10;
  var batt3 = parseInt(data.splice(8),16) /10;
  console.log("Batt: " + batt1 + " " + batt2 + " " + batt3);
  return [batt1, batt2];
}
export function rangeparse(data) {
  var range1 = parseInt(data.splice(0,4),16) /10;
  var range2 = parseInt(data.splice(4,8),16) /10;
  console.log("Range: " + range1 + " " + range2);
  return range1;
}
export function accelparse(data) {
  //return 3rd int
  return parseInt(data.splice(8),16) * 0.0625;
}
export function brakeparse(data) {
  // uint, char, char - last one we want.
  return parseInt(data.splice(8),16);
}
export function speedparse(data) {
  // uint, char, char - first one we want
  return parseInt(data.splice(0,4),16) /64;
}
export function steerparse(data) {
  // signed long 4byte
  return long(data.splice(0,8));
}
export function powerparse(data, extra) {
  var amps = long(extra[0].splice(0,8)) / 100;
  var volts = parseInt(data.splice(0,4),16) /100;
  return (amps*volts) / 1000; // KW
}

export function acparse(data) {
  return parseInt(data.splice(0,2),16);
}
export function acouttempparse(data) {
  return (parseInt(data.splice(0,2),16)/2)-40;
}
export function acintempparse(data) {
  return parseInt(data.splice(0,2),16);
}
export function acsettempparse(data) {
  return parseInt(data.splice(0,2),16)/2; // try first byte, then try second
}
