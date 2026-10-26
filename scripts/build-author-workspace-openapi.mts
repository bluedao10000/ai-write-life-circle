import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { workspaceResumeSchema } from '../packages/contracts/src/resume.js'
const extension = {
  schemas: { WorkspaceResume: z.toJSONSchema(workspaceResumeSchema, { target: 'draft-2020-12' }) },
  paths: {},
}
const output = JSON.stringify(extension, null, 2) + '\n'
const path = 'harness/contracts/author-workspace-extension.json'
if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== output) throw Error('Author workspace contract drift') }
else await writeFile(path, output)
