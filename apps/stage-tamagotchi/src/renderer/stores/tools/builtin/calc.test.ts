import { describe, expect, it } from 'vitest'

import { convertUnits, evaluateExpression } from './calc'

describe('evaluateExpression', () => {
  it('respects operator precedence', () => {
    expect(evaluateExpression('3 + 4 * 2').value).toBe(11)
    expect(evaluateExpression('(3 + 4) * 2').value).toBe(14)
  })

  it('handles unary minus and exponentiation', () => {
    expect(evaluateExpression('-5 + 3').value).toBe(-2)
    expect(evaluateExpression('2 ^ 10').value).toBe(1024)
    expect(evaluateExpression('2 ** 3 ** 2').value).toBe(512) // right-assoc
  })

  it('supports modulo and division', () => {
    expect(evaluateExpression('17 % 5').value).toBe(2)
    expect(evaluateExpression('100 / 8').value).toBe(12.5)
  })

  it('supports functions and constants', () => {
    expect(evaluateExpression('sqrt(144)').value).toBe(12)
    expect(evaluateExpression('max(3, 7, 2)').value).toBe(7)
    expect(evaluateExpression('round(pi * 100)').value).toBe(314)
  })

  it('reports division and modulo by zero', () => {
    expect(evaluateExpression('1 / 0').error).toContain('division by zero')
    expect(evaluateExpression('1 % 0').error).toContain('modulo by zero')
  })

  it('rejects malformed input and unknown names', () => {
    expect(evaluateExpression('').error).toBeTruthy()
    expect(evaluateExpression('3 +').error).toBeTruthy()
    expect(evaluateExpression('(1 + 2').error).toContain('parenthesis')
    expect(evaluateExpression('foo(2)').error).toContain('unknown function')
    expect(evaluateExpression('2 #').error).toContain('unexpected character')
  })

  it('does not execute arbitrary code', () => {
    // A property access that eval() would resolve must be a parse error here.
    expect(evaluateExpression('constructor').error).toBeTruthy()
  })
})

describe('convertUnits', () => {
  it('converts length', () => {
    expect(convertUnits(100, 'cm', 'm').value).toBe(1)
    expect(convertUnits(1, 'km', 'm').value).toBe(1000)
  })

  it('converts mass and data with aliases', () => {
    expect(convertUnits(1, 'kilograms', 'g').value).toBe(1000)
    expect(convertUnits(1, 'GB', 'MB').value).toBe(1024)
  })

  it('converts temperature (affine)', () => {
    expect(convertUnits(32, 'f', 'c').value).toBe(0)
    expect(convertUnits(100, 'celsius', 'fahrenheit').value).toBe(212)
    expect(convertUnits(0, 'c', 'k').value).toBeCloseTo(273.15)
  })

  it('rejects cross-category conversions', () => {
    expect(convertUnits(1, 'kg', 'm').error).toContain('categories')
    expect(convertUnits(1, 'c', 'kg').error).toContain('temperature')
  })

  it('rejects unknown units', () => {
    expect(convertUnits(1, 'flerbs', 'm').error).toContain('different unit categories')
    expect(convertUnits(1, 'foo', 'bar').error).toContain('unknown unit')
  })
})
