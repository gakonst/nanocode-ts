export type ArithScope = { get(name: string, index?: number): string; set(name: string, value: number, index?: number): void };

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

const OPERATORS = ["<<=", ">>=", "**", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "/=", "%=", "&=", "^=", "|=", "+", "-", "*", "/", "%", "<", ">", "&", "^", "|", "!", "~", "?", ":", "=", "(", ")", "[", "]", ","];

const ASSIGN = ["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="];

export class ArithError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const number = source.slice(i).match(/^(0[xX][0-9a-fA-F]+|\d+#[0-9a-zA-Z@_]+|\d+)/);
    if (number) {
      const text = number[0];
      let value: number;
      if (/^0[xX]/.test(text)) value = parseInt(text, 16);
      else if (text.includes("#")) {
        const [base, digits] = text.split("#");
        value = parseInt(digits, Number(base));
      } else if (text.length > 1 && text.startsWith("0")) value = parseInt(text, 8);
      else value = Number(text);
      if (Number.isNaN(value)) throw new ArithError("value too great for base (error token is \"" + text + "\")");
      tokens.push({ kind: "num", value });
      i += text.length;
      continue;
    }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) {
      tokens.push({ kind: "name", value: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find(op => source.startsWith(op, i));
    if (!op) throw new ArithError("syntax error: invalid arithmetic operator (error token is \"" + source.slice(i) + "\")");
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  return tokens;
}

const BINARY: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10, "**": 11 };

function apply(op: string, a: number, b: number, run: boolean): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return Math.trunc(a * b);
    case "/":
    case "%":
      if (b === 0) {
        if (!run) return 0;
        throw new ArithError("division by 0");
      }
      return op === "/" ? Math.trunc(a / b) : a % b;
    case "**": return Math.trunc(a ** b);
    case "<<": return a * 2 ** b;
    case ">>": return Math.floor(a / 2 ** b);
    case "<": return Number(a < b);
    case ">": return Number(a > b);
    case "<=": return Number(a <= b);
    case ">=": return Number(a >= b);
    case "==": return Number(a === b);
    case "!=": return Number(a !== b);
    case "&": return Number(BigInt.asIntN(64, BigInt(a) & BigInt(b)));
    case "|": return Number(BigInt.asIntN(64, BigInt(a) | BigInt(b)));
    case "^": return Number(BigInt.asIntN(64, BigInt(a) ^ BigInt(b)));
  }
  throw new ArithError("unknown operator " + op);
}

export function evaluateArith(source: string, scope: ArithScope, depth = 0): number {
  if (depth > 32) throw new ArithError("expression recursion level exceeded");
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === "op" && peek()!.value === value;
  const expect = (value: string) => {
    if (!isOp(value)) throw new ArithError("syntax error in expression (error token is \"" + (peek() ? String(peek()!.value) : "") + "\")");
    pos++;
  };
  const variable = (name: string, index?: number): number => {
    const text = scope.get(name, index).trim();
    if (text === "") return 0;
    if (/^-?\d+$/.test(text)) return Number(text);
    return evaluateArith(text, scope, depth + 1);
  };
  const subscript = (run: boolean): number | undefined => {
    if (!isOp("[")) return undefined;
    pos++;
    const index = comma(run);
    expect("]");
    return index;
  };
  function comma(run: boolean): number {
    let value = assign(run);
    while (isOp(",")) {
      pos++;
      value = assign(run);
    }
    return value;
  }
  function assign(run: boolean): number {
    const token = peek();
    if (token?.kind === "name") {
      const save = pos;
      pos++;
      const index = subscript(run);
      const next = peek();
      if (next?.kind === "op" && ASSIGN.includes(next.value)) {
        pos++;
        const right = assign(run);
        const value = next.value === "=" ? right : apply(next.value.slice(0, -1), variable(token.value, index), right, run);
        if (run) scope.set(token.value, value, index);
        return value;
      }
      pos = save;
    }
    return ternary(run);
  }
  function ternary(run: boolean): number {
    const cond = binary(1, run);
    if (!isOp("?")) return cond;
    pos++;
    const yes = comma(run && cond !== 0);
    expect(":");
    const no = assign(run && cond === 0);
    return cond !== 0 ? yes : no;
  }
  function binary(min: number, run: boolean): number {
    let left = unary(run);
    for (;;) {
      const token = peek();
      if (token?.kind !== "op") break;
      const prec = BINARY[token.value];
      if (prec === undefined || prec < min) break;
      pos++;
      if (token.value === "&&") {
        const right = binary(prec + 1, run && left !== 0);
        left = Number(left !== 0 && right !== 0);
      } else if (token.value === "||") {
        const right = binary(prec + 1, run && left === 0);
        left = Number(left !== 0 || right !== 0);
      } else {
        const right = binary(token.value === "**" ? prec : prec + 1, run);
        left = apply(token.value, left, right, run);
      }
    }
    return left;
  }
  function unary(run: boolean): number {
    const token = peek();
    if (token?.kind === "op") {
      if (token.value === "++" || token.value === "--") {
        pos++;
        const name = peek();
        if (name?.kind !== "name") throw new ArithError("syntax error: operand expected");
        pos++;
        const index = subscript(run);
        const value = variable(name.value, index) + (token.value === "++" ? 1 : -1);
        if (run) scope.set(name.value, value, index);
        return value;
      }
      if (["+", "-", "!", "~"].includes(token.value)) {
        pos++;
        const value = unary(run);
        return token.value === "-" ? -value : token.value === "!" ? Number(value === 0) : token.value === "~" ? ~value : value;
      }
    }
    return postfix(run);
  }
  function postfix(run: boolean): number {
    const token = peek();
    if (!token) throw new ArithError("syntax error: operand expected");
    pos++;
    if (token.kind === "num") return token.value;
    if (token.kind === "op") {
      if (token.value !== "(") throw new ArithError("syntax error: operand expected (error token is \"" + token.value + "\")");
      const value = comma(run);
      expect(")");
      return value;
    }
    const index = subscript(run);
    const value = variable(token.value, index);
    if (isOp("++") || isOp("--")) {
      const op = String(tokens[pos++].value);
      if (run) scope.set(token.value, value + (op === "++" ? 1 : -1), index);
    }
    return value;
  }
  if (!tokens.length) return 0;
  const value = comma(true);
  if (pos < tokens.length) throw new ArithError("syntax error in expression (error token is \"" + String(tokens[pos].value) + "\")");
  return value;
}
