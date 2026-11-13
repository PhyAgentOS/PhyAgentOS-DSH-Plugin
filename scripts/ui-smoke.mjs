import { DshProfileStore, ForgeCatalog, SkillFileStore, resolveForgeHome, forgePaths } from '../packages/core/lib/index.js'
import { startUiServer } from '../packages/skill/lib/ui/server.js'
const paths = forgePaths(resolveForgeHome())
const server = await startUiServer({
  profiles: new DshProfileStore(),
  files: new SkillFileStore(new ForgeCatalog(paths.skills)),
  currentProfile: 'web',
  port: 19080,
})
console.log('listening')
setTimeout(() => { server.close(); process.exit(0) }, 90000)
