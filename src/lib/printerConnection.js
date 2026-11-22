const DEFAULT_MQTT_PORT = 8883;

function printerConnection(printer) {
  const url = typeof printer?.url === 'string' ? printer.url.trim() : '';
  const serialNumber = typeof printer?.serialNumber === 'string' ? printer.serialNumber.trim() : '';
  const portValue = printer?.port ?? DEFAULT_MQTT_PORT;
  if (typeof portValue !== 'string' && typeof portValue !== 'number') return null;
  const portText = String(portValue).trim();
  if (portText && !/^\d+$/.test(portText)) return null;
  const port = Number(portText || DEFAULT_MQTT_PORT);
  if (!url || !serialNumber || serialNumber === 'FILL_THIS_OUT' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { url, port, serialNumber };
}

function samePrinterConnection(first, second) {
  const a = printerConnection(first), b = printerConnection(second);
  return !!(a && b && a.url.toLowerCase() === b.url.toLowerCase() && a.port === b.port && a.serialNumber === b.serialNumber);
}

function hasSavedAccessCode(printer) {
  const code = typeof printer?.accessCode === 'string' ? printer.accessCode.trim() : '';
  return !!code && code !== 'FILL_THIS_OUT';
}

module.exports = { printerConnection, samePrinterConnection, hasSavedAccessCode };
