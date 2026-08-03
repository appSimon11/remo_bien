// Conexión y parseo de datos por Bluetooth: remadora FTMS (Merach R50 y compatibles) + banda de FC.
// Todo esto es opcional — sin conectar nada, "Remo libre" sigue funcionando con el cronómetro propio.

import { $, state, describeError } from "./state.js";
import { updateDashboard, recordSample } from "./session.js";

const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const ROWER_DATA_CHAR = "00002ad1-0000-1000-8000-00805f9b34fb";
const CONTROL_POINT_CHAR = "00002ad9-0000-1000-8000-00805f9b34fb";
const HEART_RATE_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
const HEART_RATE_CHAR = "00002a37-0000-1000-8000-00805f9b34fb";

let packetsReceived = 0;

// Algunas remadoras FTMS se quedan "conectadas" pero nunca mandan datos hasta que la app
// le "pide control" y le dice "arranca" por el Control Point — sin esto, la suscripción a
// Rower Data se queda callada para siempre aunque no haya ningún error. Es un intento best-
// effort: si la remadora no tiene este característico o no le importa, simplemente no pasa nada.
async function kickStartFtmsMachine(service) {
  try {
    const controlPoint = await service.getCharacteristic(CONTROL_POINT_CHAR);
    await controlPoint.startNotifications();
    await controlPoint.writeValue(new Uint8Array([0x00])); // Request Control
    await new Promise((resolve) => setTimeout(resolve, 200));
    await controlPoint.writeValue(new Uint8Array([0x07])); // Start or Resume
  } catch (err) {
    console.warn("Control Point FTMS no disponible o no aceptado (puede ser normal):", err);
  }
}

function parseRowerData(dataView) {
  let offset = 0;
  const flags = dataView.getUint16(offset, true);
  offset += 2;
  const out = {};

  if ((flags & 0x0001) === 0) {
    out.strokeRate = dataView.getUint8(offset) * 0.5;
    offset += 1;
    out.strokeCount = dataView.getUint16(offset, true);
    offset += 2;
  }
  if (flags & 0x0002) { out.avgStrokeRate = dataView.getUint8(offset) * 0.5; offset += 1; }
  if (flags & 0x0004) {
    const b0 = dataView.getUint8(offset), b1 = dataView.getUint8(offset + 1), b2 = dataView.getUint8(offset + 2);
    out.totalDistance = b0 | (b1 << 8) | (b2 << 16);
    offset += 3;
  }
  if (flags & 0x0008) { out.instPace = dataView.getUint16(offset, true); offset += 2; }
  if (flags & 0x0010) { out.avgPace = dataView.getUint16(offset, true); offset += 2; }
  if (flags & 0x0020) { out.instPower = dataView.getInt16(offset, true); offset += 2; }
  if (flags & 0x0040) { out.avgPower = dataView.getInt16(offset, true); offset += 2; }
  if (flags & 0x0080) { out.resistanceLevel = dataView.getInt16(offset, true); offset += 2; }
  if (flags & 0x0100) {
    out.totalEnergy = dataView.getUint16(offset, true); offset += 2;
    out.energyPerHour = dataView.getUint16(offset, true); offset += 2;
    out.energyPerMinute = dataView.getUint8(offset); offset += 1;
  }
  if (flags & 0x0200) { out.heartRate = dataView.getUint8(offset); offset += 1; }
  if (flags & 0x0400) { out.metEquivalent = dataView.getUint8(offset) * 0.1; offset += 1; }
  if (flags & 0x0800) { out.elapsedTime = dataView.getUint16(offset, true); offset += 2; }
  if (flags & 0x1000) { out.remainingTime = dataView.getUint16(offset, true); offset += 2; }

  return out;
}

function onRowerData(event) {
  packetsReceived += 1;
  const diag = $("liveDeviceDiag");
  if (diag) diag.textContent = `Datos recibidos: ${packetsReceived}`;

  const parsed = parseRowerData(event.target.value);
  if (parsed.strokeRate != null) state.latest.spm = parsed.strokeRate;
  if (parsed.strokeCount != null) state.latest.strokes = parsed.strokeCount;
  if (parsed.totalDistance != null) state.latest.distance = parsed.totalDistance;
  if (parsed.instPace != null) state.latest.pace = parsed.instPace;
  if (parsed.instPower != null) state.latest.power = parsed.instPower;
  if (parsed.totalEnergy != null) state.latest.cal = parsed.totalEnergy;
  if (parsed.heartRate != null && !state.hrConnected) state.latest.hr = parsed.heartRate;
  if (parsed.elapsedTime != null) state.latest.elapsed = parsed.elapsedTime;
  updateDashboard();
  recordSample();
}

function setConnState(connected) {
  const pill = $("liveConnState");
  pill.textContent = connected ? "Conectado" : "Desconectado";
  pill.className = connected ? "live-pill live-pill-on" : "live-pill live-pill-off";
}

export async function connect() {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FTMS_SERVICE],
    });
  } catch (err) {
    console.error(err);
    alert("No se pudo abrir la lista de dispositivos: " + describeError(err));
    return;
  }

  try {
    state.device = device;
    $("liveDeviceName").textContent = `Vinculado: ${state.device.name || "remadora"}`;
    state.device.addEventListener("gattserverdisconnected", () => setConnState(false));

    state.server = await state.device.gatt.connect();
    const service = await state.server.getPrimaryService(FTMS_SERVICE);
    const char = await service.getCharacteristic(ROWER_DATA_CHAR);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", onRowerData);

    packetsReceived = 0;
    $("liveDeviceDiag").textContent = "Esperando datos de la remadora...";
    await kickStartFtmsMachine(service);

    setConnState(true);
    $("liveBtnStart").disabled = false;
  } catch (err) {
    console.error(err);
    alert(`"${device.name || "ese dispositivo"}" no tiene el servicio de remadora (FTMS). Detalle: ` + describeError(err));
  }
}

function parseHeartRate(dataView) {
  const flags = dataView.getUint8(0);
  const is16bit = (flags & 0x01) !== 0;
  return is16bit ? dataView.getUint16(1, true) : dataView.getUint8(1);
}
function onHeartRateData(event) {
  state.latest.hr = parseHeartRate(event.target.value);
  updateDashboard();
}

export async function connectHR() {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }],
      optionalServices: [HEART_RATE_SERVICE],
    });
  } catch (err) {
    console.error(err);
    alert("No se pudo abrir la lista de dispositivos: " + describeError(err));
    return;
  }

  try {
    state.hrDevice = device;
    $("liveHrDeviceName").textContent = `Vinculado: ${state.hrDevice.name || "banda de FC"}`;
    state.hrDevice.addEventListener("gattserverdisconnected", () => { state.hrConnected = false; });

    state.hrServer = await state.hrDevice.gatt.connect();
    const service = await state.hrServer.getPrimaryService(HEART_RATE_SERVICE);
    const char = await service.getCharacteristic(HEART_RATE_CHAR);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", onHeartRateData);

    state.hrConnected = true;
  } catch (err) {
    console.error(err);
    alert(`"${device.name || "ese dispositivo"}" no tiene el servicio de FC estándar. Detalle: ` + describeError(err));
  }
}
