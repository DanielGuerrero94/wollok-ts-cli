import chalk from 'chalk'
import { time, timeEnd } from 'node:console'
import logger from 'loglevel'
import { Entity, Environment, Node, Test, is, match, when, WRENatives as natives, interpret, Describe } from 'wollok-ts'
import { buildEnvironmentForProject, failureDescription, successDescription, valueDescription, validateEnvironment, handleError, ENTER, sanitizeStackTrace, buildEnvironmentIcon, testIcon } from '../utils.ts'
import { logger as fileLogger } from '../logger.ts'
import { TimeMeasurer } from '../time-measurer.ts'
import { Package } from 'wollok-ts'
import process from 'node:process'

const { log } = console

export type Options = {
  file: string | undefined,
  describe: string | undefined,
  test: string | undefined,
  project: string
  skipValidations: boolean
}

class TestSearchMissError extends Error{}

export function validateParameters(filter: string | undefined, { file, describe, test }: Options): void {
  if (filter && (file || describe || test)) throw new Error('You should either use filter by full name or file/describe/test.')
}

export function matchingTestDescription(filter: string | undefined, options: Options): string {
  if(filter) return `matching ${valueDescription(filter)}`
  if(options.file || options.describe || options.test) {
    const stringifiedOrWildcard = (value?: string) => value ? `'${value}'` : '*'
    return `matching ${valueDescription([options.file, options.describe, options.test].map(stringifiedOrWildcard).join('.'))}`
  }
  return ''
}

export function sanitize(value?: string): string | undefined {
  return value?.replaceAll('"', '')
}

export function getTarget(environment: Environment, filter: string | undefined, options: Options): Test[] {
  let possibleTargets: Test[]
  try {
    possibleTargets = getBaseNode(environment, filter, options).descendants.filter(getTestFilter(filter, options))
    const onlyTarget = possibleTargets.find((test: Test) => test.isOnly)
    const testMatches = (filter: string) => (test: Test) => !filter || sanitize(test.fullyQualifiedName)!.includes(filter)
    const filterTest = sanitize(filter) ?? ''
    return onlyTarget ? [onlyTarget] : possibleTargets.filter(testMatches(filterTest))
  } catch(e: any){
    if(e instanceof TestSearchMissError){
      logger.error(chalk.red(chalk.bold(e.message)))
      return []
    }
    throw e
  }
}

function getBaseNode(environment: Environment, filter: string | undefined, options: Options): Environment | Package | Describe {
  if (filter) return environment

  const { file, describe } = options
  let nodeToFilter: Environment | Package | Describe | undefined = environment
  if (file) {
    nodeToFilter = nodeToFilter.descendants.find(node => node.is(Package) && node.fileName === file) as Package | undefined
    if(!nodeToFilter) throw new TestSearchMissError(`File '${file}' not found`)
  }
  if (describe) {
    nodeToFilter = nodeToFilter.descendants.find(node => node.is(Describe) && node.name === `"${describe}"`) as Describe | undefined
    if(!nodeToFilter) throw new TestSearchMissError(`Describe '${describe}' not found`)
  }
  return nodeToFilter
}

function getTestFilter(filter: string | undefined, options: Options): (node: Node) => node is Test {
  return filter || !options.test ?
    is(Test) :
    (node: Node): node is Test => node.is(Test) && node.name === `"${options.test}"`
}
export function tabulationForNode({ fullyQualifiedName }: { fullyQualifiedName: string }): string {
  return '  '.repeat(fullyQualifiedName.split('.').length - 1)
}

export default async function (filter: string | undefined, options: Options): Promise<void> {
  try {
    validateParameters(filter, options)

    const timeMeasurer = new TimeMeasurer()
    const { project, skipValidations } = options

    const matchLog = matchingTestDescription(filter, options)
    const runAllTestsDescription = `${testIcon} Running all tests${matchLog ? ` ${matchLog} `: ' '}on ${valueDescription(project)}`

    logger.info(runAllTestsDescription)

    logger.info(`${buildEnvironmentIcon} Building environment for ${valueDescription(project)}...${ENTER}`)
    const environment = await buildEnvironmentForProject(project)
    validateEnvironment(environment, skipValidations)

    const targets = getTarget(environment, filter, options)

    logger.info(`Running ${targets.length} tests...`)

    const debug = logger.getLevel() <= logger.levels.DEBUG
    if (debug) time('Run finished')
    const interpreter = interpret(environment, natives)
    const failures: [Test, Error][] = []
    let successes = 0

    environment.forEach((node: Node) => match(node)(
      when(Test)((node: Test) => {
        if (targets.includes(node)) {
          const tabulation = tabulationForNode(node)
          try {
            interpreter.fork().exec(node)
            logger.info(tabulation, successDescription(node.name))
            successes++
          } catch (error: any) {
            logger.info(tabulation, failureDescription(node.name))
            failures.push([node, error])
          }
        }
      }),

      when(Entity)((node: Entity) => {
        const tabulation = tabulationForNode(node)
        if(targets.some(target => node.descendants.includes(target))){
          logger.info(tabulation, node.name)
        }
      }),

      when(Node)((_: Node) => { }),
    ))

    log()
    if (debug) timeEnd('Run finished')

    failures.forEach(([test, error]) => {
      log()
      logger.error(failureDescription(chalk.bold(test.fullyQualifiedName), error))
    })

    const failuresForLogging = failures.map(([test, error]) => ({
      test: test.fullyQualifiedName,
      error: sanitizeStackTrace(error),
    }))
    fileLogger.info({ message: `${testIcon} Test runner executed ${filter ? `matching ${filter} ` : ''}on ${project}`, result: { ok: successes, failed: failures.length }, failures: failuresForLogging, timeElapsed: timeMeasurer.elapsedTime() })

    logger.info(
      ENTER,
      successDescription(`${successes} passing`),
      failures.length ? failureDescription(`${failures.length} failing`) : '',
      ENTER
    )

    if (failures.length) {
      process.exit(2)
    }
  } catch (error: any) {
    handleError(error)
    return process.exit(1)
  }
}
