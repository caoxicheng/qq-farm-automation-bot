import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(scriptDir, '..', 'build', 'test')
const testFiles = fs.readdirSync(testDir)
  .filter(name => name.endsWith('.test.js') || name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join(testDir, name))

if (testFiles.length === 0) {
  throw new Error(`未找到编译后的测试: ${testDir}`)
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: path.resolve(scriptDir, '..'),
  stdio: 'inherit',
})

if (result.error)
  throw result.error
process.exitCode = result.status ?? 1
