const alphabets = ['bc', 'fg', 'jk', 'mq', 'vw', 'xz']

export const marks = (turn: number) => {
  const [a, b] = alphabets[(turn - 1) % alphabets.length]!.split('') as [string, string]
  return { first: a + b + a + b, last: (b + a).repeat(4) }
}
