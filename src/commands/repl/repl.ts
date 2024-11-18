/* eslint-disable no-console */
import { bold } from 'chalk'
import { Command } from 'commander'
import logger from 'loglevel'
import { Interface, createInterface as Repl } from 'readline'
import { Entity, Environment, Evaluation, Interpreter, Package, REPL, interprete, link, WRENatives as natives } from 'wollok-ts'
import { logger as fileLogger } from '../../logger'
import { TimeMeasurer } from '../../time-measurer'
import { ENTER, buildEnvironmentForProject, failureDescription, getFQN, handleError, replIcon, sanitizeStackTrace, successDescription, validateEnvironment, valueDescription } from '../../utils'
import { initializeClient, Options } from './diagram'
import { autocomplete } from './autocomplete'

export default async function (autoImportPath: string | undefined, options: Options): Promise<void> {
  replFn(autoImportPath, options)
}

const history: string[] = []

export async function replFn(autoImportPath: string | undefined, options: Options): Promise<Interface> {
  logger.info(`${replIcon}  Initializing Wollok REPL ${autoImportPath ? `for file ${valueDescription(autoImportPath)} ` : ''}on ${valueDescription(options.project)}`)

  let interpreter = await initializeInterpreter(autoImportPath, options)
  const autoImportName = autoImportPath && interpreter.evaluation.environment.replNode().name
  const repl = Repl({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    removeHistoryDuplicates: true,
    tabSize: 2,
    prompt: bold(`wollok${autoImportName ? ':' + autoImportName : ''}> `),
    completer: autocomplete,
  })
  let dynamicDiagramClient = await initializeClient(options, repl, interpreter)

  const onReloadClient = async (activateDiagram: boolean, newInterpreter?: Interpreter) => {
    const selectedInterpreter = newInterpreter ?? interpreter
    if (activateDiagram && !dynamicDiagramClient.enabled) {
      options.skipDiagram = !activateDiagram
      dynamicDiagramClient = await initializeClient(options, repl, selectedInterpreter)
    } else {
      dynamicDiagramClient.onReload(selectedInterpreter)
      logger.info(successDescription('Dynamic diagram reloaded at ' + bold(`http://${options.host}:${options.port}`)))
      repl.prompt()
    }
  }

  const onReloadInterpreter = (newInterpreter: Interpreter, rerun: boolean) => {
    interpreter = newInterpreter
    const previousCommands = [...history]
    history.length = 0
    if (rerun) {
      previousCommands.forEach(command => {
        repl.prompt()
        repl.write(command + ENTER)
      })
    }
    repl.prompt()
  }

  const commandHandler = defineCommands(autoImportPath, options, onReloadClient, onReloadInterpreter)

  const multilineState: { history: string[], brackets: string[], finished: () => boolean} = {
    history: [],
    brackets: [],
    finished: () => multilineState.brackets.length === 0,
  }

  const multilineHandler = (line: string): string[] => {
    multilineState.history.push(line)
    if (line.endsWith('{')) multilineState.brackets.push('{')
    if (line.endsWith('}')) multilineState.brackets.pop()
    const prompt = '... '
    repl.setPrompt(prompt + '  '.repeat(multilineState.brackets.length))
    return multilineState.finished() ? multilineState.history : []
  }

  repl
    .on('close', () => console.log(''))
    .on('line', line => {
      line = line.trim()

      const isMultiline = !multilineState.finished() || line.endsWith('{')

      if (line.length) {
        if (line.startsWith(':')) commandHandler.parse(line.split(' '), { from: 'user' })
        else if (isMultiline) {
          const multiline = multilineHandler(line)
          if (multiline.length) {
            const oneLine = multiline.join('\n')
            history.push(oneLine)
            console.log(interpreteLine(interpreter, oneLine))
            dynamicDiagramClient.onReload(interpreter)
            repl.setPrompt(bold(`wollok${autoImportName ? ':' + autoImportName : ''}> `))
            multilineState.brackets = []
            multilineState.history = []
          }
        }
        else {
          history.push(line)
          console.log(interpreteLine(interpreter, line))
          dynamicDiagramClient.onReload(interpreter)
        }
      }
      repl.prompt()
    })

  repl.prompt()
  return repl
}

export function interpreteLine(interpreter: Interpreter, line: string): string {
  const { errored, result, error } = interprete(interpreter, line)
  return errored ? failureDescription(result, error) : successDescription(result)
}

export async function initializeInterpreter(autoImportPath: string | undefined, { project, skipValidations }: Options): Promise<Interpreter> {
  let environment: Environment
  const timeMeasurer = new TimeMeasurer()

  try {
    environment = await buildEnvironmentForProject(project)
    validateEnvironment(environment, skipValidations)

    if (autoImportPath) {
      const fqn = getFQN(project, autoImportPath)
      const entity = environment.getNodeOrUndefinedByFQN<Entity>(fqn)

      if (entity && entity.is(Package)) {
        environment.scope.register([REPL, entity]) // Register the auto-imported package as REPL package
      } else {
        console.log(failureDescription(`File ${valueDescription(autoImportPath)} doesn't exist or is outside of project ${project}!`))
        process.exit(11)
      }
    } else {
      // Create a new REPL package
      const replPackage = new Package({ name: REPL })
      environment = link([replPackage], environment)
    }
    return new Interpreter(Evaluation.build(environment, natives))
  } catch (error: any) {
    handleError(error)
    fileLogger.info({ message: `${replIcon} REPL execution - build failed for ${project}`, timeElapsed: timeMeasurer.elapsedTime(), ok: false, error: sanitizeStackTrace(error) })
    return process.exit(12)
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function defineCommands(autoImportPath: string | undefined, options: Options, reloadClient: (activateDiagram: boolean, interpreter?: Interpreter) => Promise<void>, setInterpreter: (interpreter: Interpreter, rerun: boolean) => void): Command {
  const reload = (rerun = false) => async () => {
    logger.info(successDescription('Reloading environment'))
    const interpreter = await initializeInterpreter(autoImportPath, options)
    setInterpreter(interpreter, rerun)
    reloadClient(options.skipDiagram, interpreter)
  }

  const commandHandler = new Command('Write a Wollok sentence or command to evaluate')
    .usage(' ')
    .allowUnknownOption()
    .helpOption(false)
    .addHelpText('afterAll', ' ')
    .action(() => commandHandler.outputHelp())

  commandHandler.command(':quit')
    .alias(':q')
    .alias(':exit')
    .description('Quit Wollok REPL')
    .allowUnknownOption()
    .action(() => process.exit(0))

  commandHandler.command(':reload')
    .alias(':r')
    .description('Reloads all currently imported packages and resets evaluation state')
    .allowUnknownOption()
    .action(reload())

  commandHandler.command(':rerun')
    .alias(':rr')
    .description('Same as "reload" but additionaly reruns all commands written since last reload')
    .allowUnknownOption()
    .action(reload(true))

  commandHandler.command(':diagram')
    .alias(':d')
    .description('Opens Dynamic Diagram')
    .allowUnknownOption()
    .action(async () => {
      reloadClient(true)
    })

  commandHandler.command(':help')
    .alias(':h')
    .description('Show Wollok REPL help')
    .allowUnknownOption()
    .action(() => commandHandler.outputHelp())

  return commandHandler
}

