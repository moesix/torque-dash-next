const PID_NAME_MAP = {
  'k11': 'Throttle Position (%)',
  'k45': 'Relative Throttle (%)',
  'k49': 'Pedal Position D (%)',
  'k4a': 'Pedal Position E (%)',
  'k5': 'Engine Coolant Temp (°C)',
  'kb': 'Intake Manifold Pressure (psi)',
  'kc': 'Engine RPM',
  'kd': 'Vehicle Speed (km/h)',
  'ke': 'Timing Advance (°)',
  'kff1001': 'MAF Airflow Speed (km/h)',
  'kff1007': 'GPS Bearing (°)',
  'kff1238': 'Control Module Voltage (V)',
  'kff124d': 'Air-Fuel Ratio (:1)',
};

function buildContext(session, settings, telemetrySample, pidKeys) {
  const lines = [];

  const parts = [];
  if (settings.vehicleYear) parts.push(String(settings.vehicleYear));
  if (settings.vehicleMake) parts.push(settings.vehicleMake);
  if (settings.vehicleModel) parts.push(settings.vehicleModel);
  if (parts.length) lines.push(`Vehicle: ${parts.join(' ')}`);
  if (settings.engineCc) lines.push(`Engine: ${settings.engineCc}cc`);

  const sanitize = (s) => String(s).replace(/[\n\r]/g, ' ').substring(0, 100);
  lines.push(`Session: ${sanitize(session.name) || 'Unnamed'}`);
  if (session.startLocation && session.startLocation !== '-') {
    lines.push(`Location: ${session.startLocation} → ${session.endLocation || '?'}`);
  }

  lines.push(`Duration: ${session.duration || 'unknown'}`);
  lines.push(`Data points: ${telemetrySample.length}`);
  lines.push(`PID keys discovered: ${pidKeys.join(', ') || 'none'}`);

  return lines.join('\n');
}

function buildTelemetryCsv(telemetrySample, pidKeys) {
  if (!telemetrySample.length) return '(no telemetry data)';

  const MAX_ROWS = 200;
  let rows = telemetrySample;

  if (telemetrySample.length > MAX_ROWS) {
    const first = telemetrySample.slice(0, 50);
    const last = telemetrySample.slice(-50);
    rows = [...first, ...last];
  }

  // Build human-readable header names
  const colNames = [
    'Timestamp',
    'Lat',
    'Lon',
    'RPM',
    'Speed',
    ...pidKeys.map(k => PID_NAME_MAP[k] || k),
  ];

  const lines = [];
  lines.push(`| ${colNames.join(' | ')} |`);
  lines.push(`|${colNames.map(() => '---').join('|')}|`);

  for (const row of rows) {
    const values = row.values || {};
    const cells = [
      row.timestamp,
      row.lat ?? '',
      row.lon ?? '',
      row.engine_rpm ?? '',
      row.vehicle_speed ?? '',
      ...pidKeys.map(k => values[k] ?? ''),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  if (telemetrySample.length > MAX_ROWS) {
    lines.push(`(showing first 50 + last 50 of ${telemetrySample.length} rows)`);
  }

  return lines.join('\n');
}

function buildAnalysisPrompt(session, settings, telemetrySample, pidKeys) {
  const context = buildContext(session, settings, telemetrySample, pidKeys);
  const telemetryTable = buildTelemetryCsv(telemetrySample, pidKeys);

  // Build PID reference table with value ranges
  const pidRefLines = [];
  if (pidKeys.length) {
    pidRefLines.push('');
    for (const key of pidKeys) {
      const name = PID_NAME_MAP[key] || key;
      // Compute range from telemetry data
      let min = Infinity;
      let max = -Infinity;
      for (const row of telemetrySample) {
        const val = row.values && row.values[key];
        if (val !== undefined && val !== null && val !== '') {
          const num = Number(val);
          if (!Number.isNaN(num)) {
            if (num < min) min = num;
            if (num > max) max = num;
          }
        }
      }
      const rangeStr = min !== Infinity ? ` — range ${min}-${max}` : '';
      pidRefLines.push(`- ${key}: ${name}${rangeStr}`);
    }
  }

  return `You are an automotive diagnostic expert analyzing OBD-II telemetry data from a Torque Pro session.

## Vehicle & Session Context
${context}
${pidRefLines.length ? `\n## PID Reference\n${pidRefLines.join('\n')}` : ''}

## Telemetry Data (markdown table)
Column headers are human-readable labels mapped from raw OBD-II PIDs.
${telemetryTable}

## Analysis Request
Analyze this telemetry data and provide:

1. **Engine Health Assessment** — RPM patterns, idle behavior, any anomalies or fluctuations that suggest issues
2. **Driving Behavior** — speed patterns, acceleration/deceleration behavior, aggression indicators
3. **Fuel Efficiency Observations** — any patterns that suggest good or poor fuel economy
4. **Potential Mechanical Concerns** — anything unusual in the data that warrants attention
5. **Recommendations** — actionable next steps for the vehicle owner

Be specific. Reference actual data points (e.g. "RPM spiked to X at timestamp Y").
If the data looks normal, say so — don't invent problems.

## Output Format Requirements

Format your response using structured markdown:

- Use ## for main sections (Engine Health, Driving Behavior, etc.)
- Use ### for subsections
- Use **bold** for key findings and metric names
- Use \`inline code\` for specific values and PIDs
- Use bullet lists for observations
- Use markdown tables for comparisons (e.g. before/after, min/max/avg)
- Use > blockquotes for important warnings or recommendations
- Use ✅ ❌ ⚠️ status indicators where appropriate

Example structure:
## 1. Engine Health Assessment
**Coolant temperature** was well regulated: ✅
- Started at 79°C, peaked at 90°C
- No overheating detected

## 2. Driving Behavior
| Metric | Value | Assessment |
|--------|-------|------------|
| Avg Speed | 47 km/h | Normal |
| Max RPM | 2,673 | Within range |`;
}

module.exports = { buildAnalysisPrompt, buildTelemetryCsv, buildContext };
