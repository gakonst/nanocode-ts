const { byteView, fromBase64, randomBytes, toBase64, toHex } = core;
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const pad = (bytes, blockSize, lengthBytes) => {
  const total = Math.ceil((bytes.length + 1 + lengthBytes) / blockSize) * blockSize;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 4, bits >>> 0);
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  return view;
};
const sha256K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
const sha256 = (bytes) => {
  const view = pad(bytes, 64, 8);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + sha256K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((value, i) => { h[i] = (h[i] + value) | 0; });
  }
  const out = new DataView(new ArrayBuffer(32));
  h.forEach((value, i) => out.setInt32(i * 4, value));
  return new Uint8Array(out.buffer);
};
const sha1 = (bytes) => {
  const view = pad(bytes, 64, 8);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Int32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotr(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 31);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotr(a, 27) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotr(b, 2); b = a; a = t;
    }
    [a, b, c, d, e].forEach((value, i) => { h[i] = (h[i] + value) | 0; });
  }
  const out = new DataView(new ArrayBuffer(20));
  h.forEach((value, i) => out.setInt32(i * 4, value));
  return new Uint8Array(out.buffer);
};
const sha512K = "428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725 06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df 650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001 c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb 5b9cca4f7763e373 682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec 90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c d186b8c721c0c207 eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b 28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a 5fcb6fab3ad6faec 6c44198c4a475817";
const sha512 = (bytes, size = 64) => {
  const K = sha512K.split(" ").map((word) => BigInt("0x" + word));
  const M = (1n << 64n) - 1n;
  const R = (x, n) => ((x >> n) | (x << (64n - n))) & M;
  const view = pad(bytes, 128, 16);
  const h = (size === 48
    ? "cbbb9d5dc1059ed8 629a292a367cd507 9159015a3070dd17 152fecd8f70e5939 67332667ffc00b31 8eb44a8768581511 db0c2e0d64f98fa7 47b5481dbefa4fa4"
    : "6a09e667f3bcc908 bb67ae8584caa73b 3c6ef372fe94f82b a54ff53a5f1d36f1 510e527fade682d1 9b05688c2b3e6c1f 1f83d9abfb41bd6b 5be0cd19137e2179").split(" ").map((word) => BigInt("0x" + word));
  const w = new Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 128) {
    for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(offset + i * 8);
    for (let i = 16; i < 80; i++) {
      const s0 = R(w[i - 15], 1n) ^ R(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = R(w[i - 2], 19n) ^ R(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 80; i++) {
      const t1 = (k + (R(e, 14n) ^ R(e, 18n) ^ R(e, 41n)) + ((e & f) ^ (~e & M & g)) + K[i] + w[i]) & M;
      const t2 = ((R(a, 28n) ^ R(a, 34n) ^ R(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M;
      k = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
    }
    [a, b, c, d, e, f, g, k].forEach((value, i) => { h[i] = (h[i] + value) & M; });
  }
  const out = new DataView(new ArrayBuffer(64));
  h.forEach((value, i) => out.setBigUint64(i * 8, value));
  return new Uint8Array(out.buffer, 0, size).slice();
};
const hashes = { "SHA-1": [sha1, 64], "SHA-256": [sha256, 64], "SHA-384": [(bytes) => sha512(bytes, 48), 128], "SHA-512": [sha512, 128] };
const algorithmName = (algorithm) => String(typeof algorithm === "string" ? algorithm : algorithm?.name ?? "").toUpperCase().replace(/^SHA(\d)/, "SHA-$1");
const hashOf = (algorithm) => {
  const found = hashes[algorithmName(algorithm)];
  if (!found) throw new DOMException("Unrecognized hash algorithm " + JSON.stringify(typeof algorithm === "string" ? algorithm : algorithm?.name) + ": Code Mode cells support SHA-1, SHA-256, SHA-384 and SHA-512", "NotSupportedError");
  return found;
};
const bufferSource = (data) => {
  const bytes = byteView(data);
  if (!bytes) throw new TypeError("expected an ArrayBuffer or a typed array, got " + (typeof data === "string" ? "a string (encode it with new TextEncoder().encode(text))" : typeof data));
  return bytes;
};
const hmac = (hashName, key, data) => {
  const [hash, block] = hashOf(hashName);
  let secret = key.length > block ? hash(key) : key;
  const padded = new Uint8Array(block);
  padded.set(secret);
  const inner = new Uint8Array(block + data.length), outer = new Uint8Array(block + (hashName === "SHA-1" ? 20 : hashName === "SHA-384" ? 48 : hashName === "SHA-512" ? 64 : 32));
  for (let i = 0; i < block; i++) { inner[i] = padded[i] ^ 0x36; outer[i] = padded[i] ^ 0x5c; }
  inner.set(data, block);
  outer.set(hash(inner), block);
  return hash(outer);
};
const keys = new WeakMap();
const unsupported = (name) => async () => { throw new DOMException("crypto.subtle." + name + " is not available in Code Mode cells: they support digest (SHA-1, SHA-256, SHA-384, SHA-512) and HMAC importKey, sign and verify", "NotSupportedError"); };
const subtle = {
  digest: async (algorithm, data) => hashOf(algorithm)[0](bufferSource(data)).buffer,
  importKey: async (format, keyData, algorithm, extractable = false, usages = []) => {
    if (algorithmName(algorithm) !== "HMAC") return unsupported("importKey for " + algorithmName(algorithm))();
    const hash = algorithmName(algorithm.hash ?? "SHA-256");
    hashOf(hash);
    const bytes = format === "raw" ? bufferSource(keyData).slice() : format === "jwk" ? fromBase64(keyData.k) : null;
    if (!bytes) return unsupported("importKey with format " + format)();
    const key = { type: "secret", extractable, usages: [...usages], algorithm: { name: "HMAC", hash: { name: hash }, length: bytes.length * 8 } };
    keys.set(key, bytes);
    return key;
  },
  exportKey: async (format, key) => { if (!key.extractable) throw new DOMException("key is not extractable", "InvalidAccessError"); return format === "raw" ? keys.get(key).slice().buffer : { kty: "oct", k: toBase64(keys.get(key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), alg: "HS" + key.algorithm.hash.name.slice(4), ext: true }; },
  sign: async (algorithm, key, data) => { if (algorithmName(algorithm) !== "HMAC" || !keys.has(key)) return unsupported("sign for " + algorithmName(algorithm))(); return hmac(key.algorithm.hash.name, keys.get(key), bufferSource(data)).buffer; },
  verify: async (algorithm, key, signature, data) => { const expected = new Uint8Array(await subtle.sign(algorithm, key, data)); const given = bufferSource(signature); return expected.length === given.length && expected.every((byte, i) => byte === given[i]); },
  generateKey: unsupported("generateKey"),
  encrypt: unsupported("encrypt"),
  decrypt: unsupported("decrypt"),
  deriveBits: unsupported("deriveBits"),
  deriveKey: unsupported("deriveKey"),
  wrapKey: unsupported("wrapKey"),
  unwrapKey: unsupported("unwrapKey"),
};
const crypto = {
  getRandomValues: (array) => {
    if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) throw new DOMException("getRandomValues expects an integer typed array", "TypeMismatchError");
    if (array.byteLength > 65536) throw new DOMException("getRandomValues accepts at most 65536 bytes", "QuotaExceededError");
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(randomBytes(array.byteLength));
    return array;
  },
  randomUUID: () => {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = toHex(bytes);
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  },
  subtle,
};
return { crypto };
