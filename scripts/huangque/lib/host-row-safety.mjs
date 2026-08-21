export const HOSTED_D1_ROW_MAX_BYTES = 1_500_000;
export const HOSTED_URL_MAX_BYTES = 8_192;

export function hostedUtf8Bytes(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

export function hostedD1RowBytes(value) {
  return hostedUtf8Bytes(JSON.stringify(value));
}

export function assertHostedD1Row(value, label = "hosted D1 row", maximum = HOSTED_D1_ROW_MAX_BYTES) {
  const bytes = hostedD1RowBytes(value);
  if (bytes <= maximum) return bytes;
  throw Object.assign(new Error(`${label} is ${bytes} bytes; maximum is ${maximum}`), {
    code: "HOSTED_D1_ROW_TOO_LARGE",
    status: 413,
    httpStatus: 413,
  });
}

export function isHostedUrlLengthSafe(value) {
  return typeof value === "string" && hostedUtf8Bytes(value) <= HOSTED_URL_MAX_BYTES;
}
