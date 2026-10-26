export function fingerprint(bytes: ArrayBuffer | ArrayBufferView): string {
  const data = bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ data.length;
  for (let i = 0; i < data.length; i++) {
    a = Math.imul(a ^ data[i]!, 0x01000193);
    b = Math.imul(b ^ data[i]!, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0") + "-" + data.length.toString(36);
}

