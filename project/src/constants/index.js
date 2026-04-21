'use strict';

/**
 * Domain constants for fleet fuel analytics.
 * Thresholds and flags will be refined in Part 5 after query analysis.
 */

// ─── Thresholds ───────────────────────────────────────────────────────────────

// Minimum fuel-level rise (%) to be classified as a refill event
const FUEL_REFILL_MIN_CHANGE = 10;

// Minimum fuel-level drop (%) to be classified as a theft / abnormal-loss event
const FUEL_THEFT_MIN_CHANGE = 10;

// Trips shorter than this (minutes) are ignored as noise / micro-stops
const MIN_VALID_RUNNING_MINUTES = 2;

// ─── Database Table Names (from Part 2 discovery) ───────────────────────────

// CRM Database tables
const CRM_DB_NAME = 'CRM_REMOTE';
const CRM_FLEET_VEHICLES_TABLE = 'ERP_Tracking.dbo.FleetVehicles';
const CRM_VEHICLES_TABLE = 'ERP_Tracking.dbo.Vehicles'; // Main vehicles table with VEH_REG
const CRM_SENSOR_MAPPING_TABLE = 'ERP_Tracking.dbo.VehicleSensors'; // In CRM DB, not Tracking
const CRM_FLEET_LOGIN_TABLE = 'ERP_Tracking.dbo.FleetLogin'; // Fleet login credentials table

// Tracking Database tables
const TRACKING_DATA_TABLE_PREFIX = 'TrackData';

// ─── Tracking Table Column Names (from Part 2 discovery) ──────────────────────
// CONFIRMED: Tracking table has dedicated columns for common sensors

const TRACKING_VEHICLE_COLUMN = 'V_Id';
const TRACKING_TIMESTAMP_COLUMN = 'ServerTime';
const TRACKING_PARAMS_COLUMN = 'Params';

// Dedicated sensor columns (not in params)
const TRACKING_BATTERY_COLUMN = 'Battery';
const TRACKING_BACKUP_BATTERY_COLUMN = 'BackupBattery';
const TRACKING_POWER_VOLT_COLUMN = 'PowerVolt';
const TRACKING_FUEL_COLUMN = 'FuelLevel';
const TRACKING_IGNITION_COLUMN = 'Ignition';
const TRACKING_ENGINE_CUT_COLUMN = 'EngineCut';

// ─── Sensor Key Mapping (ioXXX param keys from TrackData params column) ─────
// These map the "param" column value from VehicleSensors to the ioXXX key in TrackData
// Format in params JSON: "io{NUMBER}": "value"
// UPDATE THESE after confirming exact mappings from VehicleSensors table

const SENSOR_TYPE_FUEL = 'fuel';
const SENSOR_TYPE_BATTERY = 'battery';
const SENSOR_TYPE_ENGINE_HOURS = 'engine_hours';
const SENSOR_TYPE_GENERATOR = 'generator';

// Default sensor key mappings (ioXXX numbers)
// These will be overridden by per-vehicle mappings from VehicleSensors table
const DEFAULT_SENSOR_KEYS = {
  fuel: '327',          // io327 typically contains fuel ADC value
  battery: '9',         // io9 typically contains battery percentage
  engineHours: '239',   // io239 typically contains runtime
  generator: '236',     // io236 may contain generator state
};

// ─── Environment & Debugging ────────────────────────────────────────────────

// Enables verbose logging; true in all non-production environments
const DEBUG_MODE = process.env.NODE_ENV !== 'production';

module.exports = {
  FUEL_REFILL_MIN_CHANGE,
  FUEL_THEFT_MIN_CHANGE,
  MIN_VALID_RUNNING_MINUTES,
  CRM_DB_NAME,
  CRM_FLEET_VEHICLES_TABLE,
  CRM_VEHICLES_TABLE,
  CRM_SENSOR_MAPPING_TABLE,
  CRM_FLEET_LOGIN_TABLE,
  TRACKING_DATA_TABLE_PREFIX,
  TRACKING_VEHICLE_COLUMN,
  TRACKING_TIMESTAMP_COLUMN,
  TRACKING_PARAMS_COLUMN,
  TRACKING_BATTERY_COLUMN,
  TRACKING_BACKUP_BATTERY_COLUMN,
  TRACKING_POWER_VOLT_COLUMN,
  TRACKING_FUEL_COLUMN,
  TRACKING_IGNITION_COLUMN,
  TRACKING_ENGINE_CUT_COLUMN,
  SENSOR_TYPE_FUEL,
  SENSOR_TYPE_BATTERY,
  SENSOR_TYPE_ENGINE_HOURS,
  SENSOR_TYPE_GENERATOR,
  DEFAULT_SENSOR_KEYS,
  DEBUG_MODE,
};
