import { ChildProcess } from "child_process";
import { BufferedListener, createBufferedListener } from "./listener";
import stripAnsi from "strip-ansi";

interface ProcessDriver {
  process: ChildProcess;
  waitForStdoutIncludes(
    pattern: string | string[],
    timeout?: number
  ): Promise<void>;
  waitForStderrIncludes(
    pattern: string | string[],
    timeout?: number
  ): Promise<void>;
}

type ProcessOutput = "stdout" | "stderr";

function createProcessDriver(
  process: ChildProcess,
  defaultTimeout = 30000
): ProcessDriver {
  const listeners: Record<ProcessOutput, BufferedListener<string>> = {
    stdout: createBufferedListener(),
    stderr: createBufferedListener(),
  };

  if (process.stdout) {
    process.stdout.on("data", (data) => {
      const content = stripAnsi(data.toString());
      listeners.stdout.ingest(content);
    });
  }

  if (process.stderr) {
    process.stderr.on("data", (data) => {
      const content = stripAnsi(data.toString());
      listeners.stderr.ingest(content);
    });
  }

  const waitForOutputIncludes = (
    output: ProcessOutput,
    pattern: string | string[],
    timeout: number
  ) =>
    new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(
            `Exceeded time on waiting for "${pattern}" to appear in the ${output}.`
          )
        );
      }, timeout);

      listeners[output].apply(
        {
          resolve: () => {
            clearTimeout(timeoutId);
            listeners[output] = createBufferedListener(
              listeners[output].buffer
            );
            resolve();
          },
          reject: (error) => {
            clearTimeout(timeoutId);
            listeners[output] = createBufferedListener(
              listeners[output].buffer
            );
            reject(error);
          },
          string: pattern,
        },
        (chunk, listener) => {
          let index = -1;
          const strings = Array.isArray(pattern) ? pattern : [pattern];

          strings.forEach((string) => {
            const stringIndex = chunk.indexOf(string);

            index = Math.max(
              index,
              stringIndex === -1 ? -1 : stringIndex + string.length
            );
          });

          if (index !== -1) {
            listener.resolve();
            return chunk.slice(index);
          }
        }
      );
    });

  return {
    process,
    waitForStdoutIncludes: (string, timeout = defaultTimeout) =>
      waitForOutputIncludes("stdout", string, timeout),
    waitForStderrIncludes: (string, timeout = defaultTimeout) =>
      waitForOutputIncludes("stderr", string, timeout),
  };
}

export { createProcessDriver, ProcessDriver };
