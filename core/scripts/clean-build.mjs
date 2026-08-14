import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.resolve(scriptDir, '..', 'build')

fs.rmSync(buildDir, { recursive: true, force: true })
