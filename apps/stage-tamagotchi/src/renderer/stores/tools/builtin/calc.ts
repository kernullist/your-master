/**
 * Pure, dependency-free arithmetic evaluator and unit converter for the
 * calculator tools. A weak local model is unreliable at mental math; these
 * give it an exact fallback.
 *
 * The evaluator is a small recursive-descent parser (NOT eval) supporting
 * + - * / %, unary minus, exponentiation (^ or **), parentheses, a few
 * functions (sqrt/abs/round/floor/ceil/min/max), and constants (pi, e).
 */

interface EvalResult {
  ok: boolean
  value?: number
  error?: string
}

interface FunctionSpec {
  fn: (...args: number[]) => number
  /** Minimum and maximum argument count; max Infinity for variadic. */
  minArgs: number
  maxArgs: number
}

const FUNCTIONS: Record<string, FunctionSpec> = {
  sqrt: { fn: Math.sqrt, minArgs: 1, maxArgs: 1 },
  abs: { fn: Math.abs, minArgs: 1, maxArgs: 1 },
  round: { fn: Math.round, minArgs: 1, maxArgs: 1 },
  floor: { fn: Math.floor, minArgs: 1, maxArgs: 1 },
  ceil: { fn: Math.ceil, minArgs: 1, maxArgs: 1 },
  min: { fn: Math.min, minArgs: 1, maxArgs: Number.POSITIVE_INFINITY },
  max: { fn: Math.max, minArgs: 1, maxArgs: Number.POSITIVE_INFINITY },
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
}

/**
 * Evaluates an arithmetic expression safely.
 *
 * Before:
 * - "3 + 4 * 2", "(1+2)^3", "sqrt(144)", "max(3, 7, 2)"
 *
 * After:
 * - { ok: true, value: 11 / 27 / 12 / 7 }
 *
 * Returns `{ ok: false, error }` on malformed input or math errors (e.g.
 * division by zero, non-finite results). Never executes arbitrary code.
 */
export function evaluateExpression(expression: string): EvalResult {
  const input = expression ?? ''
  // Tokenize: numbers, identifiers, operators, parens, comma.
  const tokens: string[] = []
  const tokenRegex = /\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z]+|\*\*|[-+*/%^(),])/giy
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(input)) !== null) {
    tokens.push(match[1])
    lastIndex = tokenRegex.lastIndex
  }
  if (input.trim() !== '' && lastIndex !== input.length) {
    return { ok: false, error: `unexpected character near "${input.slice(lastIndex).trim().slice(0, 12)}"` }
  }
  if (tokens.length === 0) {
    return { ok: false, error: 'empty expression' }
  }

  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  // Forward declarations via function hoisting.
  function parseExpression(): number {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
    }
    return value
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next()
      const rhs = parseFactor()
      if (op === '*') {
        value *= rhs
      }
      else if (op === '/') {
        if (rhs === 0) {
          throw new Error('division by zero')
        }
        value /= rhs
      }
      else {
        if (rhs === 0) {
          throw new Error('modulo by zero')
        }
        value %= rhs
      }
    }
    return value
  }

  function parseFactor(): number {
    if (peek() === '-') {
      next()
      return -parseFactor()
    }
    if (peek() === '+') {
      next()
      return parseFactor()
    }
    return parsePower()
  }

  function parsePower(): number {
    const base = parsePrimary()
    if (peek() === '^' || peek() === '**') {
      next()
      // Right-associative: exponent parses a factor (allows -2^-2).
      return base ** parseFactor()
    }
    return base
  }

  function parsePrimary(): number {
    const token = peek()
    if (token === undefined) {
      throw new Error('unexpected end of expression')
    }

    if (token === '(') {
      next()
      const value = parseExpression()
      if (next() !== ')') {
        throw new Error('missing closing parenthesis')
      }
      return value
    }

    if (/^[a-z]+$/i.test(token)) {
      next()
      if (peek() === '(') {
        const spec = FUNCTIONS[token.toLowerCase()]
        if (!spec) {
          throw new Error(`unknown function "${token}"`)
        }
        next() // consume '('
        const args: number[] = []
        if (peek() !== ')') {
          args.push(parseExpression())
          while (peek() === ',') {
            next()
            args.push(parseExpression())
          }
        }
        if (next() !== ')') {
          throw new Error(`missing closing parenthesis after ${token}(`)
        }
        if (args.length < spec.minArgs || args.length > spec.maxArgs) {
          const expects = spec.maxArgs === Number.POSITIVE_INFINITY
            ? `at least ${spec.minArgs}`
            : spec.minArgs === spec.maxArgs ? `${spec.minArgs}` : `${spec.minArgs}-${spec.maxArgs}`
          throw new Error(`${token}() expects ${expects} argument(s), got ${args.length}`)
        }
        return spec.fn(...args)
      }

      const constant = CONSTANTS[token.toLowerCase()]
      if (constant === undefined) {
        throw new Error(`unknown name "${token}"`)
      }
      return constant
    }

    const num = Number(token)
    if (Number.isNaN(num)) {
      throw new TypeError(`unexpected token "${token}"`)
    }
    next()
    return num
  }

  try {
    const value = parseExpression()
    if (pos !== tokens.length) {
      return { ok: false, error: `unexpected token "${peek()}"` }
    }
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'result is not a finite number' }
    }
    return { ok: true, value }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// --- Unit conversion ------------------------------------------------------

interface ConvertResult {
  ok: boolean
  value?: number
  error?: string
}

// NOTICE:
// Each category maps a unit to its factor relative to a base unit. Conversion
// is value * fromFactor / toFactor. Temperature is special-cased (affine, not
// a simple ratio). Currency is intentionally excluded — it needs live rates;
// the model should use web search for that.
const LINEAR_UNITS: Record<string, Record<string, number>> = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { mg: 0.001, g: 1, kg: 1000, t: 1_000_000, oz: 28.349523125, lb: 453.59237 },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 },
  time: { ms: 0.001, s: 1, min: 60, h: 3600, day: 86400, week: 604800 },
}

const UNIT_ALIASES: Record<string, string> = {
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  kilometer: 'km',
  kilometers: 'km',
  kilometre: 'km',
  centimeter: 'cm',
  centimeters: 'cm',
  millimeter: 'mm',
  millimeters: 'mm',
  inch: 'in',
  inches: 'in',
  foot: 'ft',
  feet: 'ft',
  yard: 'yd',
  yards: 'yd',
  mile: 'mi',
  miles: 'mi',
  gram: 'g',
  grams: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  milligram: 'mg',
  tonne: 't',
  ton: 't',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  byte: 'b',
  bytes: 'b',
  kilobyte: 'kb',
  megabyte: 'mb',
  gigabyte: 'gb',
  terabyte: 'tb',
  second: 's',
  seconds: 's',
  sec: 's',
  minute: 'min',
  minutes: 'min',
  hour: 'h',
  hours: 'h',
  hr: 'h',
  days: 'day',
  weeks: 'week',
  celsius: 'c',
  centigrade: 'c',
  fahrenheit: 'f',
  kelvin: 'k',
}

function normalizeUnit(unit: string): string {
  const lower = unit.trim().toLowerCase()
  return UNIT_ALIASES[lower] ?? lower
}

function convertTemperature(value: number, from: string, to: string): ConvertResult {
  // Normalize to Celsius first.
  let celsius: number
  if (from === 'c') {
    celsius = value
  }
  else if (from === 'f') {
    celsius = (value - 32) * 5 / 9
  }
  else if (from === 'k') {
    celsius = value - 273.15
  }
  else {
    return { ok: false, error: `unknown temperature unit "${from}"` }
  }

  if (to === 'c') {
    return { ok: true, value: celsius }
  }
  if (to === 'f') {
    return { ok: true, value: celsius * 9 / 5 + 32 }
  }
  if (to === 'k') {
    return { ok: true, value: celsius + 273.15 }
  }
  return { ok: false, error: `unknown temperature unit "${to}"` }
}

/**
 * Converts a value between units of the same category.
 *
 * Before:
 * - (100, "cm", "m") / (32, "f", "c") / (1, "gb", "mb")
 *
 * After:
 * - { ok: true, value: 1 / 0 / 1024 }
 *
 * Supports length, mass, data, time (ratio) and temperature (affine). Units
 * are alias-normalized (e.g. "kilometers" -> "km"). Cross-category or unknown
 * units return an error.
 */
export function convertUnits(value: number, fromUnit: string, toUnit: string): ConvertResult {
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'value must be a finite number' }
  }

  const from = normalizeUnit(fromUnit)
  const to = normalizeUnit(toUnit)

  const tempUnits = new Set(['c', 'f', 'k'])
  if (tempUnits.has(from) || tempUnits.has(to)) {
    if (!tempUnits.has(from) || !tempUnits.has(to)) {
      return { ok: false, error: 'cannot convert between temperature and non-temperature units' }
    }
    return convertTemperature(value, from, to)
  }

  for (const units of Object.values(LINEAR_UNITS)) {
    if (from in units && to in units) {
      return { ok: true, value: value * units[from] / units[to] }
    }
    if (from in units || to in units) {
      // One side is in this category but the other is not -> mismatch.
      return { ok: false, error: `cannot convert "${fromUnit}" to "${toUnit}" (different unit categories)` }
    }
  }

  return { ok: false, error: `unknown unit "${fromUnit}" or "${toUnit}"` }
}
