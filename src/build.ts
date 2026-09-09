import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { branchId } from './commands';
import { project } from './project';
import { requiredEnvironment } from './validation';

const directory = resolve(requiredEnvironment('APP_DIR'));
const branch = requiredEnvironment('PREVIEW_BRANCH');
if (branchId(branch) !== branch || project.publicBuildEnvironment.VITE_API_BASE_URL !== project.apiUrl) {
  throw new Error('Preview branch or public test API environment is invalid');
}

for (const script of [...project.validationScripts, project.buildScript, ...project.additionalBuildScripts]) {
  const result = spawnSync('pnpm', [script], {
    cwd: directory,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...project.publicBuildEnvironment,
      VITE_PREVIEW_BRANCH: branch,
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Project script failed: ${script}`);
  }
}
