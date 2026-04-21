'use strict';

/**
 * Analytics Service — calculates vehicle metrics from tracking data.
 *
 * ── Database discoveries (2026-04-15) ───────────────────────────────────────
 *
 * 1. ALL vehicles in this fleet use VehicleSensors.param = "io9" for the fuel
 *    sensor.  The raw ADC value (0–~5000) is stored in the Battery column of
 *    TrackData.  FuelLevel and Params are always NULL for these devices.
 *    Calibration from VehicleSensors converts: raw ADC → litres.
 *
 * 2. Some vehicles (e.g. 373197, 375957) store the actual 12 V power-supply
 *    voltage in Battery (values 10,000–15,000 mV). Those are NOT fuel ADC
 *    readings. Guard: skip Battery if rawValue > calibrationMaxX × 1.2.
 *
 * 3. Ignition is a SQL bit column → mssql returns JS boolean (true/false).
 *    parseInt(true, 10) === NaN, breaking all ignition math.
 *    Fixed: parseIgnitionState() handles booleans.
 *
 * 4. Battery column = fuel ADC; BackupBattery = GPS device internal battery.
 *
 * ── Fuel theft rule ─────────────────────────────────────────────────────────
 *
 * Theft is only meaningful when the generator is OFF (ignition = 0).
 * ADC sensor noise causes spurious spikes at the moment of ignition
 * transition (0-minute "OFF" windows that show 40-50 L drops) — these are
 * filtered out by requiring an OFF segment ≥ MIN_THEFT_OFF_MINUTES.
 *
 * ── Fuel consumption rule ───────────────────────────────────────────────────
 *
 * True consumption = fuel burned while ignition is ON.
 * Net consumption = first fuel reading – last fuel reading (kept as fallback).
 */

const {
  FUEL_REFILL_MIN_CHANGE,
  FUEL_THEFT_MIN_CHANGE,
  MIN_VALID_RUNNING_MINUTES,
  DEBUG_MODE,
} = require('../constants');

// Minimum duration (minutes) for an ignition-OFF segment to be considered a
// real "generator off" window — filters out ADC noise at transition moments.
const MIN_THEFT_OFF_MINUTES = 15;

// Smoothing bucket size for noise reduction
const BUCKET_MINUTES = 5;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate comprehensive analytics for a vehicle's daily tracking data.
 *
 * @param {number} vehicleId
 * @param {string} date - YYYY-MM-DD
 * @param {Object} sensorKeys - from sensorMapper.resolveSensorKeys()
 * @param {Array}  trackingRows - ordered ASC by timestamp
 * @returns {Object}
 */
function calculateVehicleAnalytics(vehicleId, date, sensorKeys, trackingRows) {
  if (!trackingRows || !Array.isArray(trackingRows) || trackingRows.length === 0) {
    return createEmptyAnalytics();
  }

  if (DEBUG_MODE) {
    const first = trackingRows[0];
    const last  = trackingRows[trackingRows.length - 1];
    console.log('[analyticsService] vehicle=%d date=%s rows=%d', vehicleId, date, trackingRows.length);
    console.log('[analyticsService] first:', {
      ignition: first.ignition, battery: first.battery,
      backupBattery: first.backupBattery, fuelLevel: first.fuelLevel,
      params: first.params ? first.params.substring(0, 80) : null,
    });
    console.log('[analyticsService] last:', {
      ignition: last.ignition, battery: last.battery,
      backupBattery: last.backupBattery,
    });
  }

  const fuelCalibration = resolveFuelCalibration(sensorKeys);
  const fuelSensorKey   = sensorKeys?.fuelKeys?.[0] ?? null;
  const calibrationMaxX = fuelCalibration
    ? Math.max(...fuelCalibration.map((p) => p.x))
    : Infinity;

  // DEBUG: Log fuel calibration and raw values for troubleshooting
  if (DEBUG_MODE) {
    console.log('[analyticsService] Fuel Debug for vehicle=%d:', vehicleId);
    console.log('  - fuelSensorKey:', fuelSensorKey ?? 'NOT SET');
    console.log('  - fuelCalibration:', JSON.stringify(fuelCalibration));
    if (trackingRows.length > 0) {
      const lastRow = trackingRows[trackingRows.length - 1];
      const params = parseParams(lastRow.params);
      console.log('  - Last row battery:', lastRow.battery);
      console.log('  - Last row fuelLevel:', lastRow.fuelLevel);
      console.log('  - Last row params:', JSON.stringify(params));
      const rawValue = parseNumeric(lastRow.battery) || getParamValue(params, fuelSensorKey);
      console.log('  - Raw ADC value:', rawValue);
      if (fuelCalibration && rawValue) {
        const calibrated = applyCalibration(rawValue, fuelCalibration);
        console.log('  - Calibrated fuel:', calibrated, 'L');
      }
    }
  }

  // Build a single merged series once — reused by all fuel functions
  const rawFuelIgnSeries = buildFuelIgnitionSeries(
    trackingRows, fuelCalibration, fuelSensorKey, calibrationMaxX
  );
  const smoothed = smoothFuelIgnitionSeries(rawFuelIgnSeries);

  return {
    batteryHealth:      calculateBatteryHealth(trackingRows),
    fuelConsumption:    calculateFuelConsumption(smoothed),
    totalEngineHours:   calculateTotalEngineHours(trackingRows),
    fuelRefilled:       calculateFuelRefilled(smoothed),
    fuelTheft:          calculateFuelTheft(smoothed),
    generatorStartTime: calculateGeneratorStartTime(trackingRows),
    generatorStopTime:  calculateGeneratorStopTime(trackingRows),
    workTime:           calculateWorkTime(trackingRows),
    fuel:               getFinalFuelValue(rawFuelIgnSeries),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUEL + IGNITION SERIES BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a merged time-series of {timestamp, fuel (litres), ignition (0|1)}
 * from raw tracking rows.
 *
 * Fuel source priority (stops at first non-null value):
 *   1. FuelLevel column (CAN bus, already in litres)
 *   2. Params[fuelSensorKey]  (io9 → key "9"; io327 → key "327") + calibrate
 *   3. Params["327"] default fallback + calibrate
 *   4. Battery column — ONLY when rawValue ≤ calibrationMaxX × 1.2
 *      (skips vehicles where Battery stores 12 V supply voltage ~14 000 mV)
 *
 * @param {Array}       rows
 * @param {Array|null}  calibration
 * @param {string|null} fuelSensorKey  e.g. "9" derived from "io9"
 * @param {number}      calibrationMaxX  max x from calibration curve
 * @returns {Array<{timestamp:Date, fuel:number, ignition:0|1|null}>}
 */
function buildFuelIgnitionSeries(rows, calibration, fuelSensorKey, calibrationMaxX) {
  const series = [];

  for (const row of rows) {
    let fuel = null;
    let needsCalibration = false;

    // 1. FuelLevel column (already litres)
    const fl = parseNumeric(row.fuelLevel);
    if (fl !== null) {
      fuel = fl;
    }

    // 2. Params[fuelSensorKey] (raw ADC → calibrate)
    if (fuel === null && fuelSensorKey) {
      const params = parseParams(row.params);
      const pv = getParamValue(params, fuelSensorKey);
      if (pv !== null) { fuel = pv; needsCalibration = true; }
    }

    // 3. Params["327"] default
    if (fuel === null) {
      const params = parseParams(row.params);
      const p327 = getParamValue(params, '327');
      if (p327 !== null) { fuel = p327; needsCalibration = true; }
    }

    // 4. Battery column — only when value is plausibly a fuel ADC reading.
    //    Vehicles 373197/375957 store actual 12 V supply (~11 000–15 000 mV)
    //    in Battery, which far exceeds the calibration range (max ~5 000).
    //    Allow values up to 2x calibration max to handle extrapolation,
    //    or use default max of 15000 when no calibration exists.
    if (fuel === null) {
      const batRaw = parseNumeric(row.battery);
      const maxAllowed = calibration ? calibrationMaxX * 2.0 : 15000; // allow extrapolation beyond calibration
      if (batRaw !== null && batRaw <= maxAllowed && batRaw >= 0) {
        fuel = batRaw;
        needsCalibration = !!calibration; // only calibrate if we have calibration data
      }
    }

    if (fuel === null) continue; // no fuel data for this row

    if (needsCalibration && calibration) {
      fuel = applyCalibration(fuel, calibration);
    }

    if (Number.isNaN(fuel)) continue;

    series.push({
      timestamp: new Date(row.timestamp),
      fuel,
      ignition: parseIgnitionState(row.ignition),
    });
  }

  return series;
}

/**
 * Smooth the raw fuel+ignition series into BUCKET_MINUTES-wide time buckets.
 *
 * Per bucket:
 *   • fuel    = median of all fuel readings in the bucket
 *   • ignition = majority vote (more ON rows → 1, more OFF → 0, else null)
 *   • timestamp = start of the bucket
 *
 * Why: The Battery ADC has noise spikes where fuel appears to drop 50 L in
 * a single second, then recover.  5-min median bucketing eliminates these.
 * ADC transition glitches (0-min OFF windows) are also absorbed into the
 * surrounding ON bucket's majority vote.
 *
 * @param {Array<{timestamp,fuel,ignition}>} series
 * @param {number} bucketMinutes
 * @returns {Array<{timestamp,fuel,ignition}>}
 */
function smoothFuelIgnitionSeries(series, bucketMinutes = BUCKET_MINUTES) {
  if (series.length === 0) return [];

  const bucketMs = bucketMinutes * 60 * 1000;
  const startTs  = series[0].timestamp.getTime();
  const buckets  = new Map(); // key → {fuels:[], onCount:0, offCount:0}

  for (const pt of series) {
    const key = Math.floor((pt.timestamp.getTime() - startTs) / bucketMs);
    if (!buckets.has(key)) buckets.set(key, { fuels: [], onCount: 0, offCount: 0 });
    const b = buckets.get(key);
    b.fuels.push(pt.fuel);
    if (pt.ignition === 1) b.onCount++;
    else if (pt.ignition === 0) b.offCount++;
  }

  const result = [];
  for (const [key, b] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted  = [...b.fuels].sort((a, c) => a - c);
    const median  = sorted[Math.floor(sorted.length / 2)];
    const ignition = b.onCount > b.offCount ? 1
                   : b.offCount > b.onCount ? 0
                   : null;
    result.push({
      timestamp: new Date(startTs + key * bucketMs),
      fuel: median,
      ignition,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALIBRATION
// ═══════════════════════════════════════════════════════════════════════════════

function resolveFuelCalibration(sensorKeys) {
  if (!sensorKeys?.byParam) return null;
  for (const param of Object.keys(sensorKeys.byParam)) {
    const info = sensorKeys.byParam[param];
    if (
      Array.isArray(info?.calibration) &&
      info.calibration.length >= 2 &&
      sensorKeys.fuelKeys?.includes(info.sensorKey)
    ) {
      return info.calibration;
    }
  }
  return null;
}

/**
 * Piecewise-linear interpolation through calibration points.
 * Clamps to min/max calibration values (matches vendor portal behavior).
 *
 * @param {number} rawValue
 * @param {Array<{x:number,y:number}>} calibrationPoints
 * @returns {number} Calibrated value
 */
function applyCalibration(rawValue, calibrationPoints) {
  if (!calibrationPoints || calibrationPoints.length < 2) return rawValue;
  const sorted = [...calibrationPoints].sort((a, b) => a.x - b.x);

  // Below minimum - clamp to minimum
  if (rawValue <= sorted[0].x) return sorted[0].y;

  // Beyond maximum - clamp to maximum (vendor portal behavior)
  if (rawValue >= sorted[sorted.length - 1].x) {
    return sorted[sorted.length - 1].y;
  }

  // Within range - interpolate
  for (let i = 0; i < sorted.length - 1; i++) {
    if (rawValue >= sorted[i].x && rawValue <= sorted[i + 1].x) {
      const ratio = (rawValue - sorted[i].x) / (sorted[i + 1].x - sorted[i].x);
      return sorted[i].y + ratio * (sorted[i + 1].y - sorted[i].y);
    }
  }
  return rawValue;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IGNITION STATE PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse ignition value that may be a JS boolean (mssql bit) or numeric.
 *
 * @param {boolean|number|string|null|undefined} value
 * @returns {0|1|null}
 */
function parseIgnitionState(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number')  return Number.isNaN(value) ? null : (value === 0 ? 0 : 1);
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : (parsed === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMS PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function parseParams(paramsStr) {
  if (!paramsStr || typeof paramsStr !== 'string') return {};
  try { return JSON.parse(paramsStr); } catch { return {}; }
}

function getParamValue(paramsObj, key) {
  if (!paramsObj || typeof paramsObj !== 'object') return null;
  const value = paramsObj[key];
  if (value === null || value === undefined) return null;
  const num = parseFloat(value);
  return Number.isNaN(num) ? null : num;
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRIC CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 1. BATTERY HEALTH
 *
 * Priority:
 *  a) BackupBattery column  — GPS device internal Li-Po battery (mV)
 *  b) Params["67"]          — same, reported in V → × 1000 → mV
 *  c) Params["66"]          — vehicle/generator battery in V → × 1000 → mV
 *
 * Note: Battery/PowerVolt columns store the fuel ADC for this device family.
 *
 * @param {Array} rows - raw tracking rows
 * @returns {number|null} Battery level in mV
 */
function calculateBatteryHealth(rows) {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];

  const bb = parseNumeric(last.backupBattery);
  if (bb !== null) return round(bb, 0);

  const params = parseParams(last.params);
  const b67 = getParamValue(params, '67');
  if (b67 !== null) return round(b67 * 1000, 0);

  const b66 = getParamValue(params, '66');
  if (b66 !== null) return round(b66 * 1000, 0);

  return null;
}

/**
 * 2. FUEL CONSUMPTION
 *
 * Total fuel burned while the generator was ON (ignition = 1).
 * Uses the smoothed series — sums all drops that occur in ON-period buckets.
 * Falls back to net (first − last) if no ignition data.
 *
 * @param {Array<{timestamp,fuel,ignition}>} smoothed
 * @returns {number|null}
 */
function calculateFuelConsumption(smoothed) {
  if (smoothed.length < 2) return smoothed.length === 0 ? null : 0;

  const hasIgnitionData = smoothed.some((p) => p.ignition !== null);

  if (hasIgnitionData) {
    // Sum drops that happen while ignition is ON
    let totalConsumed = 0;
    for (let i = 0; i < smoothed.length - 1; i++) {
      if (smoothed[i].ignition === 1 && smoothed[i + 1].ignition === 1) {
        const drop = smoothed[i].fuel - smoothed[i + 1].fuel;
        if (drop > 0) totalConsumed += drop;
      }
    }
    return round(totalConsumed, 2);
  }

  // No ignition data — fall back to net consumption
  const consumption = smoothed[0].fuel - smoothed[smoothed.length - 1].fuel;
  return round(Math.max(0, consumption), 2);
}

/**
 * 3. TOTAL ENGINE HOURS
 *
 * @param {Array} rows - raw rows (ignition column)
 * @returns {number|null}
 */
function calculateTotalEngineHours(rows) {
  if (rows.length === 0) return null;
  const mins = calculateWorkTime(rows);
  return mins !== null ? round(mins / 60, 2) : null;
}

/**
 * 4. FUEL REFILLED
 *
 * Sum of upward fuel jumps ≥ FUEL_REFILL_MIN_CHANGE in the smoothed series.
 * A refill can happen at any ignition state.
 *
 * @param {Array<{timestamp,fuel,ignition}>} smoothed
 * @returns {number|null}
 */
function calculateFuelRefilled(smoothed) {
  if (smoothed.length < 2) return null;

  let total = 0;
  for (let i = 0; i < smoothed.length - 1; i++) {
    const rise = smoothed[i + 1].fuel - smoothed[i].fuel;
    if (rise >= FUEL_REFILL_MIN_CHANGE) total += rise;
  }
  return round(total, 2);
}

/**
 * 5. FUEL THEFT
 *
 * Detects fuel stolen while the generator was OFF.
 *
 * Algorithm:
 *  1. Identify consecutive OFF buckets in the smoothed series.
 *  2. Only process OFF segments lasting ≥ MIN_THEFT_OFF_MINUTES.
 *     This eliminates ADC noise glitches at ignition transitions
 *     (the 0-minute "OFF" spikes we observed with 40–50 L false drops).
 *  3. Any drop ≥ FUEL_THEFT_MIN_CHANGE across consecutive OFF buckets → theft.
 *
 * @param {Array<{timestamp,fuel,ignition}>} smoothed
 * @returns {number|null}
 */
function calculateFuelTheft(smoothed) {
  if (smoothed.length < 2) return null;

  let totalTheft = 0;

  // Collect consecutive OFF-period segments
  let segStart = null;  // index of first OFF bucket in current segment

  const processSegment = (startIdx, endIdx) => {
    if (startIdx === null || endIdx <= startIdx) return;

    const seg = smoothed.slice(startIdx, endIdx + 1);
    if (seg.length < 2) return;

    // Check duration of this OFF segment
    const durationMs = seg[seg.length - 1].timestamp - seg[0].timestamp;
    const durationMin = durationMs / (1000 * 60);
    if (durationMin < MIN_THEFT_OFF_MINUTES) return; // ignore noise window

    // Sum any drops within the OFF segment
    for (let i = 0; i < seg.length - 1; i++) {
      const drop = seg[i].fuel - seg[i + 1].fuel;
      if (drop >= FUEL_THEFT_MIN_CHANGE) totalTheft += drop;
    }
  };

  for (let i = 0; i < smoothed.length; i++) {
    const isOff = smoothed[i].ignition === 0;

    if (isOff) {
      if (segStart === null) segStart = i;
    } else {
      // Segment ended
      processSegment(segStart, i - 1);
      segStart = null;
    }
  }
  // Handle trailing OFF segment
  processSegment(segStart, smoothed.length - 1);

  return round(totalTheft, 2);
}

/**
 * 6. GENERATOR START TIME — first OFF→ON ignition transition.
 *
 * @param {Array} rows - raw rows
 * @returns {string|null} ISO timestamp
 */
function calculateGeneratorStartTime(rows) {
  if (rows.length === 0) return null;
  const transitions = detectIgnitionTransitions(rows);
  const start = transitions.find((t) => t.from === 0 && t.to === 1);
  return start ? start.timestamp.toISOString() : null;
}

/**
 * 7. GENERATOR STOP TIME — last ON→OFF ignition transition.
 *
 * @param {Array} rows - raw rows
 * @returns {string|null} ISO timestamp
 */
function calculateGeneratorStopTime(rows) {
  if (rows.length === 0) return null;
  const transitions = detectIgnitionTransitions(rows);
  const stops = transitions.filter((t) => t.from === 1 && t.to === 0);
  return stops.length > 0 ? stops[stops.length - 1].timestamp.toISOString() : null;
}

/**
 * 8. WORK TIME — total minutes ignition was ON.
 *
 * @param {Array} rows - raw rows
 * @returns {number|null} minutes (1 decimal)
 */
function calculateWorkTime(rows) {
  if (rows.length === 0) return null;

  const transitions = detectIgnitionTransitions(rows);

  if (transitions.length === 0) {
    const state = parseIgnitionState(rows[0].ignition);
    if (state === 1) {
      const dur = new Date(rows[rows.length - 1].timestamp) - new Date(rows[0].timestamp);
      return round(dur / (1000 * 60), 1);
    }
    return 0;
  }

  const intervals = buildOnIntervalsFromIgnition(rows, transitions);
  return round(sumIntervals(intervals, MIN_VALID_RUNNING_MINUTES), 1);
}

/**
 * 9. FINAL FUEL VALUE — most recent calibrated fuel reading.
 *
 * @param {Array<{timestamp,fuel,ignition}>} rawSeries (un-smoothed)
 * @returns {number|null} litres
 */
function getFinalFuelValue(rawSeries) {
  if (rawSeries.length === 0) return null;
  return round(rawSeries[rawSeries.length - 1].fuel, 2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IGNITION TRANSITION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function detectIgnitionTransitions(rows) {
  const transitions = [];
  if (rows.length < 2) return transitions;

  let prev = parseIgnitionState(rows[0].ignition);

  for (let i = 1; i < rows.length; i++) {
    const curr = parseIgnitionState(rows[i].ignition);
    if (curr === null) continue;
    if (prev !== null && curr !== prev) {
      transitions.push({ from: prev, to: curr, timestamp: new Date(rows[i].timestamp), rowIndex: i });
    }
    prev = curr;
  }

  return transitions;
}

function buildOnIntervalsFromIgnition(rows, transitions) {
  const intervals = [];
  const initial = parseIgnitionState(rows[0].ignition);
  let isOn = initial === 1;
  let start = isOn ? new Date(rows[0].timestamp) : null;

  for (const t of transitions) {
    if (t.from === 0 && t.to === 1) {
      isOn = true; start = t.timestamp;
    } else if (t.from === 1 && t.to === 0) {
      if (start !== null) {
        intervals.push({ start, end: t.timestamp, durationMinutes: (t.timestamp - start) / 60000 });
      }
      isOn = false; start = null;
    }
  }

  if (isOn && start !== null) {
    const last = new Date(rows[rows.length - 1].timestamp);
    intervals.push({ start, end: last, durationMinutes: (last - start) / 60000 });
  }

  return intervals;
}

function sumIntervals(intervals, minMinutes) {
  return intervals.reduce((total, iv) => total + (iv.durationMinutes >= minMinutes ? iv.durationMinutes : 0), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NUMERIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseNumeric(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(/,/g, ''));
    return Number.isNaN(n) ? null : n;
  }
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  return null;
}

function round(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const m = Math.pow(10, decimals);
  return Math.round(value * m) / m;
}

function createEmptyAnalytics() {
  return {
    batteryHealth: null,
    fuelConsumption: null,
    totalEngineHours: null,
    fuelRefilled: null,
    fuelTheft: null,
    generatorStartTime: null,
    generatorStopTime: null,
    workTime: null,
    fuel: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY / COMPAT HELPERS (kept for backward compat, used by extractFuelSeries)
// ═══════════════════════════════════════════════════════════════════════════════

/** @deprecated Use buildFuelIgnitionSeries instead */
function extractFuelSeries(rows, calibration, fuelSensorKey) {
  const calibrationMaxX = calibration
    ? Math.max(...calibration.map((p) => p.x))
    : Infinity;
  return buildFuelIgnitionSeries(rows, calibration, fuelSensorKey, calibrationMaxX)
    .map(({ timestamp, fuel }) => ({ timestamp, value: fuel }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  calculateVehicleAnalytics,
  // Exported for unit testing
  parseIgnitionState,
  parseParams,
  getParamValue,
  parseNumeric,
  applyCalibration,
  resolveFuelCalibration,
  buildFuelIgnitionSeries,
  smoothFuelIgnitionSeries,
  extractFuelSeries,
  detectIgnitionTransitions,
  buildOnIntervalsFromIgnition,
  sumIntervals,
};
