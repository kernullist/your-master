import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { convertUnits, evaluateExpression } from './calc'

const tools: Promise<Tool>[] = [
  tool({
    name: 'calculate',
    description: 'Evaluate an arithmetic expression exactly. Use this instead of doing math yourself. Supports + - * / %, ^ (power), parentheses, sqrt/abs/round/floor/ceil/min/max, and pi/e.',
    execute: async ({ expression }) => {
      const result = evaluateExpression(expression)
      return result.ok ? `${result.value}` : `Error: ${result.error}`
    },
    parameters: z.object({
      expression: z.string().describe('The arithmetic expression, e.g. "(1234 * 56) / 7"'),
    }),
  }),
  tool({
    name: 'convert_units',
    description: 'Convert a value between units of the same kind: length, mass, data size, time, or temperature. For currency, use web search instead (live rates).',
    execute: async ({ value, from, to }) => {
      const result = convertUnits(value, from, to)
      return result.ok ? `${result.value} ${to}` : `Error: ${result.error}`
    },
    parameters: z.object({
      value: z.number().describe('The numeric amount to convert'),
      from: z.string().describe('Source unit, e.g. "km", "lb", "GB", "fahrenheit"'),
      to: z.string().describe('Target unit, e.g. "mi", "kg", "MB", "celsius"'),
    }),
  }),
]

export const calculatorTools = async () => Promise.all(tools)
