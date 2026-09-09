import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from './commands';
import { prepare, publish } from './deploy';
import { report, resolveRequest, verifyWorkflowSource } from './github';
import { integer, requiredEnvironment } from './validation';

async function outputs(values: Record<string, string>): Promise<void> {
  const body = Object.entries(values).map(([key, value]) => {
    const delimiter = `fleetia_${randomUUID()}`;
    return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }).join('');
  await appendFile(requiredEnvironment('GITHUB_OUTPUT'), body);
}

export async function run(command: string): Promise<void> {
  if (command === 'resolve') {
    await outputs({ accepted: 'false' });
    const runId = integer(Number(requiredEnvironment('GITHUB_RUN_ID')));
    await verifyWorkflowSource(requiredEnvironment('BOT_REF'), runId);
    const event: unknown = JSON.parse(await readFile(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8'));
    const request = await resolveRequest(event, requiredEnvironment('GITHUB_EVENT_NAME'), runId);
    if (request) {
      await outputs({
        accepted: 'true', action: request.action, branch_id: request.branchId,
        request: JSON.stringify(request), sha: request.sha,
      });
    }
    return;
  }
  const request = parseRequest(JSON.parse(requiredEnvironment('REQUEST')) as unknown);
  if (command === 'prepare' || command === 'publish') {
    await outputs({ deploy: 'false', deployed_sha: '' });
    const outcome = command === 'prepare'
      ? await prepare(request)
      : await publish(request, requiredEnvironment('ARTIFACT_DIR'));
    await outputs({ deploy: String(outcome.deploy), detail: outcome.detail, deployed_sha: outcome.deployedSha });
    return;
  }
  if (command === 'report') {
    await report(request, requiredEnvironment('REPORT_STATUS'), process.env.REPORT_DETAIL ?? '', process.env.REPORT_DEPLOYED_SHA ?? '');
    return;
  }
  throw new Error('Expected resolve, prepare, publish, or report');
}

function safeMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Unknown failure';
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY/.test(name) && value) {
      message = message.replaceAll(value, '[redacted]');
    }
  }
  return message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? '';
  try {
    await run(command);
  } catch (error) {
    const detail = command === 'publish'
      ? 'Preview publishing failed. Public files may have changed; the served version is not verified.'
      : command === 'prepare'
        ? 'Preview preparation or deletion failed. Existing content or cached responses may remain.'
        : 'The preview request could not be processed.';
    const failureDetail = `${detail} ${safeMessage(error)}`;
    if (process.env.GITHUB_OUTPUT) {
      try {
        await outputs({ deploy: 'false', deployed_sha: '', detail: failureDetail });
      } catch {
        process.stderr.write('Could not record workflow output.\n');
      }
    }
    process.stderr.write(`${failureDetail}\n`);
    process.exitCode = 1;
  }
}
