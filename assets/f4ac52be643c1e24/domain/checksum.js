/** SUM4 is a teaching checksum: four hexadecimal digits, summed modulo 16. */
export function checksum(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 4) {
    throw new TypeError('SUM4 requires four hexadecimal digits.');
  }
  let sum = 0;
  for (let index = 0; index < 4; index++) {
    const digit = bytes[index];
    if (!Number.isInteger(digit) || digit < 0 || digit > 15) {
      throw new TypeError('SUM4 digits must be integers from 0 to 15.');
    }
    sum += digit;
  }
  return sum % 16;
}
