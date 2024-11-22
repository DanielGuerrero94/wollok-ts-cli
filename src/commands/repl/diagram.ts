import express, { Express } from 'express'
import cors from 'cors'
import http from 'http'
import { Server, Socket } from 'socket.io'
import { Interpreter } from 'wollok-ts'
import { Interface } from 'readline'
import { bold } from 'chalk'
import logger from 'loglevel'
import { failureDescription, getDynamicDiagram, publicPath, serverError, successDescription } from '../../utils'

type DynamicDiagramClient = {
  onReload: (interpreter: Interpreter) => void,
  enabled: boolean,
  app?: Express, // only for testing purposes
  server?: http.Server, // only for testing purposes
}

export type Options = {
  project: string
  skipValidations: boolean,
  darkMode: boolean,
  host: string,
  port: string,
  skipDiagram: boolean,
}

export async function initializeClient(options: Options, repl: Interface, interpreter: Interpreter): Promise<DynamicDiagramClient> {
  if (options.skipDiagram) {
    return { onReload: (_interpreter: Interpreter) => {}, enabled: false }
  }
  const app = express()
  const server = http.createServer(app)

  server.addListener('error', serverError)

  const io = new Server(server)

  io.on('connection', (socket: Socket) => {
    logger.debug(successDescription('Connected to Dynamic diagram'))
    socket.on('disconnect', () => { logger.debug(failureDescription('Dynamic diagram closed')) })
  })
  const connectionListener = (interpreter: Interpreter) => (socket: Socket) => {
    socket.emit('initDiagram', options)
    socket.emit('updateDiagram', getDynamicDiagram(interpreter))
  }
  let currentConnectionListener = connectionListener(interpreter)
  io.on('connection', currentConnectionListener)

  app.use(
    cors({ allowedHeaders: '*' }),
    express.static(publicPath('diagram'), { maxAge: '1d' }),
  )
  const host = options.host
  server.listen(parseInt(options.port), host)
  server.addListener('listening', () => {
    logger.info(successDescription('Dynamic diagram available at: ' + bold(`http://${host}:${options.port}`)))
    repl.prompt()
  })

  return {
    onReload: (interpreter: Interpreter) => {
      io.off('connection', currentConnectionListener)
      currentConnectionListener = connectionListener(interpreter)
      io.on('connection', currentConnectionListener)

      io.emit('updateDiagram', getDynamicDiagram(interpreter))
    },
    enabled: true,
    app,
    server,
  }
}
