class RequestValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequestValidationError';
    this.status = status;
    this.expose = true;
  }
}

/**
 * @typedef {Readonly<{
 *   time_from: number,
 *   time_to: number,
 *   page_size: number,
 *   cursor?: string,
 *   order_status?: string,
 *   response_optional_fields?: string,
 * }>} OrderListDto
 */

const ALLOWED_QUERY_FIELDS = new Set([
  'time_from', 'time_to', 'page_size', 'cursor', 'order_status', 'response_optional_fields',
]);

function integer(value, name, fallback, min, max, source) {
  if (value === undefined) return fallback;
  if (source === 'query' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new RequestValidationError(`${name} harus berupa angka bulat.`);
  }
  if (source === 'body' && !Number.isSafeInteger(value)) {
    throw new RequestValidationError(`${name} harus berupa angka bulat.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RequestValidationError(`${name} harus berada dalam rentang ${min} sampai ${max}.`);
  }
  return parsed;
}

function optionalString(value, name, maxLength, pattern) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > maxLength || !pattern.test(value)) {
    throw new RequestValidationError(`${name} tidak valid.`);
  }
  return value;
}

/** @returns {OrderListDto} */
function parseOrderInput(input, source, nowSeconds) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RequestValidationError('Data order tidak valid.');
  for (const name of Object.keys(input)) {
    if (!ALLOWED_QUERY_FIELDS.has(name)) throw new RequestValidationError(`Parameter ${name} tidak dikenal.`);
  }
  const timeTo = integer(input.time_to, 'time_to', nowSeconds, 1, Number.MAX_SAFE_INTEGER, source);
  const timeFrom = integer(input.time_from, 'time_from', timeTo - 86400, 1, Number.MAX_SAFE_INTEGER, source);
  if (timeFrom > timeTo || timeTo - timeFrom > 15 * 86400) {
    throw new RequestValidationError('Rentang waktu order harus 0 sampai 15 hari.');
  }
  const pageSize = integer(input.page_size, 'page_size', 20, 1, 100, source);
  const cursor = optionalString(input.cursor, 'cursor', 200, /^[\x21-\x7E]+$/);
  const orderStatus = optionalString(input.order_status, 'order_status', 40, /^[A-Z_]+$/);
  const responseOptionalFields = optionalString(input.response_optional_fields, 'response_optional_fields', 200, /^[a-z_]+(?:,[a-z_]+)*$/);
  return Object.freeze({
    time_from: timeFrom,
    time_to: timeTo,
    page_size: pageSize,
    cursor,
    order_status: orderStatus,
    response_optional_fields: responseOptionalFields,
  });
}

function checkPathParams(req) {
  if (req.params && Object.keys(req.params).length) throw new RequestValidationError('Parameter path order tidak dikenal.');
}

/** @returns {OrderListDto} */
function parseOrderListDto(req, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (req.method !== 'GET') throw new RequestValidationError('Metode order tidak didukung.', 405);
  checkPathParams(req);
  if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || Object.keys(req.body).length)) {
    throw new RequestValidationError('GET order tidak menerima body JSON.');
  }
  return parseOrderInput(req.query || {}, 'query', nowSeconds);
}

/** @returns {OrderListDto} */
function parseOrderSearchDto(req, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (req.method !== 'POST') throw new RequestValidationError('Metode pencarian order tidak didukung.', 405);
  checkPathParams(req);
  if (req.query !== undefined && (typeof req.query !== 'object' || req.query === null || Array.isArray(req.query) || Object.keys(req.query).length)) {
    throw new RequestValidationError('Pencarian order menerima filter melalui body JSON.');
  }
  return parseOrderInput(req.body, 'body', nowSeconds);
}

module.exports = { parseOrderListDto, parseOrderSearchDto, RequestValidationError };
