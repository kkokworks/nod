import { join } from 'node:path'
import { z } from 'zod'
import { nodHome } from '../../../src/ledger'

// The person's settings for the work tools: which are on, and each one's values (an address, an
// organization). They live in nod's home, out of the repo.
export const configPath = (): string => join(nodHome(), 'config.json')

const Config = z.object({
  // The tools that are on, by their folder name under sources/.
  sources: z.array(z.string()),
  slack: z.object({ selfDm: z.string().optional() }).optional(),
  // A repo is mine when its maintainerFile has a `<maintainerKey>: <my login>` line.
  forgejo: z
    .object({
      org: z.string(),
      maintainerFile: z.string().optional(),
      maintainerKey: z.string().optional(),
    })
    .optional(),
  // projects: the identifiers to scan, the ENG of ENG-12.
  plane: z
    .object({ url: z.string(), workspace: z.string(), projects: z.array(z.string()) })
    .optional(),
})
export type Config = z.infer<typeof Config>

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath())
  if (!(await file.exists())) {
    throw new Error(`${configPath()} is missing; skills/nod/setup.md says what goes in it`)
  }
  return Config.parse(await file.json())
}
