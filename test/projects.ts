import { realpathSync } from 'node:fs'
import { join } from 'node:path'

// The folder Claude Code keeps the transcripts of sessions run in `cwd` in, in the config dir
// `config` (2.1.309): named after the real path with each character but a letter or digit turned
// into `-`, cut at 200 characters with a hash of the path after. The fake and the tests keep
// transcripts where Claude Code does; nod looks a session up by its ID instead (worker.ts).
export function projectFolder(config: string, cwd: string): string {
  const path = realpathSync(cwd)
  const name = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= 200) return join(config, 'projects', name)
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0
  return join(config, 'projects', `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`)
}
