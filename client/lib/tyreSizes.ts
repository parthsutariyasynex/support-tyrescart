import { gql } from './api';

// The vehicle form's tyre sizes: kept by the server in one JSON file (server/config/tyre-sizes.json), never here.

export async function listTyreSizes() {
  return (await gql<{ tyreSizes: string[] }>(`query TyreSizes { tyreSizes }`)).tyreSizes;
}

// Saves a new size (the server checks the format and refuses one already listed: error code DUPLICATE). Returns the
// size as saved (capitals, a space before the R: "175/70 R13") and the whole list after it.
export async function addTyreSize(size: string) {
  const query = `mutation AddTyreSize($size: String!) { addTyreSize(size: $size) { size sizes } }`;
  return (await gql<{ addTyreSize: { size: string; sizes: string[] } }>(query, { size })).addTyreSize;
}

// "205/55 r16" and "205/55R16" are the same size, and so are "31X/10.5R15" and "31X10.5R15" (as the server compares)
const sizeKey = (s: string) => s.replace(/\s+/g, '').toUpperCase().replace(/X\//, 'X');
export const sameTyreSize = (a: string, b: string) => sizeKey(a) === sizeKey(b);
