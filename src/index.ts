import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

interface CmdOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}
// helper to read the outputs from `.exec` results
const getOutput = (res: CmdOutput) => (res.success ? res.stdout : res.stderr);

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ANTHROPIC_API_KEY: string;
};

const EXTRA_SYSTEM =
  'You are an automatic feature-implementer/bug-fixer.' +
  'You apply all necessary changes to achieve the user request. You must ensure you DO NOT commit the changes, ' +
  'so the pipeline can read the local `git diff` and apply the change upstream.';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'POST') {
      try {
        const { repo, task } = await request.json<{
          repo?: string;
          task?: string;
        }>();
        if (!repo || !task)
          return new Response('invalid body', { status: 400 });

        // get the repo name
        const name = repo.split('/').pop() ?? 'tmp';

        // open sandbox
        const sandbox = getSandbox(
          env.Sandbox,
          crypto.randomUUID().slice(0, 8)
        );

        // git clone repo
        await sandbox.gitCheckout(repo, { targetDir: name });

        const { ANTHROPIC_API_KEY } = env;

        // Set env vars for the session
        await sandbox.setEnvVars({ ANTHROPIC_API_KEY });

        // kick off CC with our query
        const cmd = `cd ${name} && claude --append-system-prompt "${EXTRA_SYSTEM}" -p "${task.replaceAll(
          '"',
          '\\"'
        )}" --permission-mode acceptEdits`;

        // Create a streaming response
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();

            try {
              // Stream Claude Code output
              controller.enqueue(encoder.encode('=== Claude Code Output ===\n\n'));

              // Get the readable stream from execStream
              const execStream = await sandbox.execStream(cmd);
              const reader = execStream.getReader();
              const decoder = new TextDecoder();

              // Read chunks from the stream
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Decode and forward the chunk
                const text = decoder.decode(value, { stream: true });
                controller.enqueue(encoder.encode(text));
              }

              reader.releaseLock();

              // After Claude Code completes, get the git diff
              controller.enqueue(encoder.encode('\n\n=== Git Diff ===\n\n'));
              const diff = getOutput(await sandbox.exec('git diff'));
              controller.enqueue(encoder.encode(diff));

              controller.close();
            } catch (error) {
              controller.enqueue(encoder.encode(`\nError: ${error instanceof Error ? error.message : String(error)}`));
              controller.close();
            }
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked'
          }
        });
      } catch {
        return new Response('invalid body', { status: 400 });
      }
    }
    return new Response('not found');
  }
};

export { Sandbox } from '@cloudflare/sandbox';
