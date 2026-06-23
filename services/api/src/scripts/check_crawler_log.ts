import * as fs from 'fs'
import * as path from 'path'

const logPath = path.join(process.cwd(), 'api.log')
if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split('\n')
  console.log(`Last 100 lines of api.log:`)
  console.log(lines.slice(-100).join('\n'))
} else {
  console.log('api.log not found at', logPath)
}
