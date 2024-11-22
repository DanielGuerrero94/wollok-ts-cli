import { CompleterResult } from 'readline'
import { logger as fileLogger } from '../../logger'
import { KEYWORDS } from 'wollok-ts'
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// EVALUATION
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TODO:
// - autocomplete piola

const keywords = Object.values(KEYWORDS)
const classes = ['new Date()', 'new Dictionary()']
const lambdas = ['{ n => n > 0 }']
const libs = ['console.println']

export function autocomplete(input: string): CompleterResult {
  fileLogger.info({ message: `${input} REPL autocomplete input`, ok: true })
  const completions = [...keywords, ...classes, ...lambdas, ...libs]
  const hits = completions.filter((c) => c.startsWith(input))
  // Show all completions if none found
  return [hits.length ? hits : completions, input]
}
