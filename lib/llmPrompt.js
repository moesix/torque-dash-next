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

  const header = ['timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed', ...pidKeys];
  const lines = [header.join(',')];

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
    lines.push(cells.join(','));
  }

  if (telemetrySample.length > MAX_ROWS) {
    lines.push(`(showing first 50 + last 50 of ${telemetrySample.length} rows)`);
  }

  return lines.join('\n');
}

function buildAnalysisPrompt(session, settings, telemetrySample, pidKeys) {
  const context = buildContext(session, settings, telemetrySample, pidKeys);
  const csv = buildTelemetryCsv(telemetrySample, pidKeys);

  return `You are an automotive diagnostic expert analyzing OBD-II telemetry data from a Torque Pro session.

## Vehicle & Session Context
${context}

## Telemetry Data (CSV format)
${csv}

## Analysis Request
Analyze this telemetry data and provide:

1. **Engine Health Assessment** — RPM patterns, idle behavior, any anomalies or fluctuations that suggest issues
2. **Driving Behavior** — speed patterns, acceleration/deceleration behavior, aggression indicators
3. **Fuel Efficiency Observations** — any patterns that suggest good or poor fuel economy
4. **Potential Mechanical Concerns** — anything unusual in the data that warrants attention
5. **Recommendations** — actionable next steps for the vehicle owner

Be specific. Reference actual data points (e.g. "RPM spiked to X at timestamp Y").
If the data looks normal, say so — don't invent problems. Format your response in
structured markdown with headers.`;
}

module.exports = { buildAnalysisPrompt, buildTelemetryCsv, buildContext };
