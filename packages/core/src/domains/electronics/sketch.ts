export type Expr = number | string;

export type Node =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'unary'; op: string; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'choice'; test: Node; yes: Node; no: Node }
  | { kind: 'call'; fn: string; args: Node[] };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
};

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_]\w*(?:\.\w+)?)|(&&|\|\||<=|>=|==|!=|[-+*/%<>!?:(),]))/y;

function tokenize(source: string) {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (!match) {
      if (!source.slice(start).trim()) break;
      throw new Error(`unexpected "${source.slice(start).trim()[0]}"`);
    }
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];

function parse(source: string): Node {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined) throw new Error('it ends too early');
    if (expected && token !== expected) throw new Error(`expected "${expected}" but found "${token}"`);
    return token;
  };
  const choice = (): Node => {
    const test = level(0);
    if (peek() !== '?') return test;
    take('?');
    const yes = choice();
    take(':');
    return { kind: 'choice', test, yes, no: choice() };
  };
  const level = (depth: number): Node => {
    if (depth === LEVELS.length) return unary();
    let left = level(depth + 1);
    while (LEVELS[depth].includes(peek())) {
      const op = take();
      left = { kind: 'binary', op, left, right: level(depth + 1) };
    }
    return left;
  };
  const unary = (): Node => {
    if (peek() === '-' || peek() === '!') {
      const op = take();
      return { kind: 'unary', op, arg: unary() };
    }
    return primary();
  };
  const primary = (): Node => {
    const token = take();
    if (token === '(') {
      const inner = choice();
      take(')');
      return inner;
    }
    if (/^\d/.test(token)) return { kind: 'number', value: Number(token) };
    if (!/^[A-Za-z_]/.test(token)) throw new Error(`unexpected "${token}"`);
    if (peek() !== '(') return { kind: 'name', name: token };
    if (!FUNCTIONS[token]) throw new Error(`${token} isn't a known function`);
    take('(');
    const args: Node[] = [];
    while (peek() !== ')') {
      args.push(choice());
      if (peek() === ',') take(',');
      else break;
    }
    take(')');
    return { kind: 'call', fn: token, args };
  };
  const node = choice();
  if (at < tokens.length) throw new Error(`unexpected "${tokens[at]}"`);
  return node;
}

const cache = new Map<string, Node>();

export function compile(expr: Expr): Node {
  if (typeof expr === 'number') return { kind: 'number', value: expr };
  let node = cache.get(expr);
  if (!node) {
    node = parse(expr);
    cache.set(expr, node);
  }
  return node;
}

export function namesIn(node: Node, out = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'name':
      out.add(node.name);
      break;
    case 'unary':
      namesIn(node.arg, out);
      break;
    case 'binary':
      namesIn(node.left, out);
      namesIn(node.right, out);
      break;
    case 'choice':
      namesIn(node.test, out);
      namesIn(node.yes, out);
      namesIn(node.no, out);
      break;
    case 'call':
      for (const arg of node.args) namesIn(arg, out);
      break;
  }
  return out;
}

export function evaluate(node: Node, lookup: (name: string) => number): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'name':
      return lookup(node.name);
    case 'unary': {
      const value = evaluate(node.arg, lookup);
      return node.op === '-' ? -value : value ? 0 : 1;
    }
    case 'choice':
      return evaluate(node.test, lookup) ? evaluate(node.yes, lookup) : evaluate(node.no, lookup);
    case 'call':
      return FUNCTIONS[node.fn](...node.args.map((arg) => evaluate(arg, lookup)));
    case 'binary': {
      const a = evaluate(node.left, lookup);
      if (node.op === '&&') return a ? Number(Boolean(evaluate(node.right, lookup))) : 0;
      if (node.op === '||') return a ? 1 : Number(Boolean(evaluate(node.right, lookup)));
      const b = evaluate(node.right, lookup);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? 0 : a / b;
        case '%':
          return b === 0 ? 0 : ((a % b) + b) % b;
        case '<':
          return Number(a < b);
        case '>':
          return Number(a > b);
        case '<=':
          return Number(a <= b);
        case '>=':
          return Number(a >= b);
        case '==':
          return Number(a === b);
        default:
          return Number(a !== b);
      }
    }
  }
}
