const lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]

const lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]

const distanceBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]

const distanceExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]

const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const fastBits = 10

const fastMask = (1 << fastBits) - 1

type Huffman = { counts: Uint16Array; fast: Int32Array; symbols: Uint16Array }

function huffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16)
  for (let symbol = 0; symbol < lengths.length; symbol++) counts[lengths[symbol]!]!++
  counts[0] = 0
  const offsets = new Uint16Array(16)
  for (let length = 1; length < 15; length++)
    offsets[length + 1] = offsets[length]! + counts[length]!
  const symbols = new Uint16Array(lengths.length)
  for (let symbol = 0; symbol < lengths.length; symbol++)
    if (lengths[symbol]) symbols[offsets[lengths[symbol]!]!++] = symbol

  const fast = new Int32Array(1 << fastBits).fill(-1)
  const next = new Uint16Array(16)
  for (let length = 1, code = 0; length < 16; length++) {
    code = (code + counts[length - 1]!) << 1
    next[length] = code
  }
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!
    if (!length) continue
    const code = next[length]!++
    if (length > fastBits) continue
    let reversed = 0
    for (let bit = 0; bit < length; bit++) reversed |= ((code >> bit) & 1) << (length - 1 - bit)
    for (let index = reversed; index < 1 << fastBits; index += 1 << length)
      fast[index] = (symbol << 4) | length
  }
  return { counts, fast, symbols }
}

const fixedLiterals = huffman(
  Uint8Array.from({ length: 288 }, (_, symbol) =>
    symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8,
  ),
)

const fixedDistances = huffman(new Uint8Array(30).fill(5))

export class InflateError extends Error {
  override readonly name: string = 'Inflate.InflateError'
}

export class TruncatedError extends InflateError {
  override readonly name = 'Inflate.TruncatedError'
}

export function zlib(input: Uint8Array, offset: number, size: number): inflate.ReturnType {
  if (offset + 2 > input.length) throw new TruncatedError('the zlib stream ends before its header')
  const method = input[offset]! & 15
  if (method !== 8 || ((input[offset]! << 8) | input[offset + 1]!) % 31 !== 0)
    throw new InflateError('the zlib stream has an invalid header')
  if (input[offset + 1]! & 32) throw new InflateError('the zlib stream needs a preset dictionary')
  const raw = inflate(input, offset + 2, size)
  if (raw.end + 4 > input.length)
    throw new TruncatedError('the zlib stream ends before its checksum')
  return { data: raw.data, end: raw.end + 4 }
}

export function inflate(input: Uint8Array, offset: number, size: number): inflate.ReturnType {
  const out = new Uint8Array(size)
  const end = input.length
  let written = 0
  let position = offset
  let buffer = 0
  let held = 0

  const short = () => new TruncatedError('the deflate stream ends early')
  const long = () => new InflateError('the deflate stream is longer than ' + size + ' bytes')

  const slow = (table: Huffman): number => {
    let code = 0
    let first = 0
    let index = 0
    for (let length = 1; length < 16; length++) {
      if (!held) {
        if (position >= end) throw short()
        buffer = input[position++]!
        held = 8
      }
      code |= buffer & 1
      buffer >>>= 1
      held--
      const count = table.counts[length]!
      if (code - count < first) return table.symbols[index + (code - first)]!
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    throw new InflateError('the deflate stream holds an invalid code')
  }

  for (let last = 0; !last; ) {
    while (held < 3) {
      if (position >= end) throw short()
      buffer |= input[position++]! << held
      held += 8
    }
    last = buffer & 1
    const type = (buffer >>> 1) & 3
    buffer >>>= 3
    held -= 3

    if (type === 0) {
      position -= held >> 3
      buffer = 0
      held = 0
      if (position + 4 > end) throw short()
      const length = input[position]! | (input[position + 1]! << 8)
      const inverse = input[position + 2]! | (input[position + 3]! << 8)
      position += 4
      if ((length ^ 0xffff) !== inverse)
        throw new InflateError('a stored deflate block has a bad length')
      if (position + length > end) throw short()
      if (written + length > size) throw long()
      out.set(input.subarray(position, position + length), written)
      written += length
      position += length
      continue
    }
    if (type === 3) throw new InflateError('the deflate stream holds a reserved block type')

    const bits = (count: number) => {
      while (held < count) {
        if (position >= end) throw short()
        buffer |= input[position++]! << held
        held += 8
      }
      const value = buffer & ((1 << count) - 1)
      buffer >>>= count
      held -= count
      return value
    }

    let literals = fixedLiterals
    let distances = fixedDistances
    if (type === 2) {
      const literalCount = bits(5) + 257
      const distanceCount = bits(5) + 1
      const codeCount = bits(4) + 4
      const codeLengths = new Uint8Array(19)
      for (let index = 0; index < codeCount; index++) codeLengths[order[index]!] = bits(3)
      const codes = huffman(codeLengths)
      const lengths = new Uint8Array(literalCount + distanceCount)
      for (let index = 0; index < lengths.length; ) {
        while (held < fastBits && position < end) {
          buffer |= input[position++]! << held
          held += 8
        }
        const entry = codes.fast[buffer & fastMask]!
        let symbol: number
        if (entry >= 0 && (entry & 15) <= held) {
          buffer >>>= entry & 15
          held -= entry & 15
          symbol = entry >> 4
        } else symbol = slow(codes)
        if (symbol < 16) {
          lengths[index++] = symbol
          continue
        }
        let repeat: number
        let value = 0
        if (symbol === 16) {
          if (!index) throw new InflateError('a deflate length repeats nothing')
          repeat = 3 + bits(2)
          value = lengths[index - 1]!
        } else if (symbol === 17) repeat = 3 + bits(3)
        else repeat = 11 + bits(7)
        if (index + repeat > lengths.length) throw new InflateError('deflate code lengths overflow')
        lengths.fill(value, index, index + repeat)
        index += repeat
      }
      literals = huffman(lengths.subarray(0, literalCount))
      distances = huffman(lengths.subarray(literalCount))
    }

    const literalFast = literals.fast
    const distanceFast = distances.fast
    for (;;) {
      if (held <= 16 && position + 1 < end) {
        buffer |= (input[position]! << held) | (input[position + 1]! << (held + 8))
        position += 2
        held += 16
      }
      while (held < fastBits && position < end) {
        buffer |= input[position++]! << held
        held += 8
      }
      let entry = literalFast[buffer & fastMask]!
      let symbol: number
      if (entry >= 0 && (entry & 15) <= held) {
        buffer >>>= entry & 15
        held -= entry & 15
        symbol = entry >> 4
      } else symbol = slow(literals)
      if (symbol < 256) {
        if (written >= size) throw long()
        out[written++] = symbol
        continue
      }
      if (symbol === 256) break
      const slot = symbol - 257
      if (slot >= 29) throw new InflateError('the deflate stream holds an invalid length')
      const lengthBits = lengthExtra[slot]!
      const length = lengthBase[slot]! + (lengthBits ? bits(lengthBits) : 0)
      while (held < fastBits && position < end) {
        buffer |= input[position++]! << held
        held += 8
      }
      entry = distanceFast[buffer & fastMask]!
      let code: number
      if (entry >= 0 && (entry & 15) <= held) {
        buffer >>>= entry & 15
        held -= entry & 15
        code = entry >> 4
      } else code = slow(distances)
      if (code >= 30) throw new InflateError('the deflate stream holds an invalid distance')
      const distanceBits = distanceExtra[code]!
      const distance = distanceBase[code]! + (distanceBits ? bits(distanceBits) : 0)
      if (distance > written) throw new InflateError('a deflate distance reaches before the output')
      if (written + length > size) throw long()
      if (distance >= length) {
        out.copyWithin(written, written - distance, written - distance + length)
        written += length
      } else
        for (let index = 0; index < length; index++, written++)
          out[written] = out[written - distance]!
    }
  }

  if (written !== size)
    throw new InflateError('the deflate stream holds ' + written + ' bytes, not ' + size)
  return { data: out, end: position - (held >> 3) }
}

export declare namespace inflate {
  type ReturnType = { data: Uint8Array; end: number }
}
