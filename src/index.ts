import { join, dirname } from "path";
import fs from "fs-extra";
import os from "os";
import { exec, ChildProcess } from "child_process";
import spawn from "cross-spawn";
import stripAnsi from "strip-ansi";
import treeKill from "tree-kill";
import chalk from "chalk";

interface Logger {
  log: (message: string) => void;
}

interface Sandbox {
  context: string;
  destroy(): Promise<void>;
  write(
    path: string,
    content: string,
    retries?: number,
    delay?: number
  ): Promise<void>;
  read(path: string, retries?: number, delay?: number): Promise<string>;
  exists(path: string, retries?: number, delay?: number): Promise<boolean>;
  remove(path: string, retries?: number, delay?: number): Promise<void>;
  patch(
    path: string,
    search: string,
    replacement: string,
    retries?: number,
    delay?: number
  ): Promise<void>;
  exec(
    command: string,
    env?: Record<string, string>,
    cwd?: string
  ): Promise<string>;
  spawn(
    command: string,
    env?: Record<string, string>,
    cwd?: string
  ): ChildProcess;
  kill(
    childProcess: ChildProcess,
    retries?: number,
    delay?: number
  ): Promise<void>;
}

const defaultLogger: Logger = {
  log(message) {
    process.stdout.write(
      message
        .split("\n")
        .map((line) => chalk.grey(`$ ${line}`))
        .join("\n")
    );
    process.stdout.write("\n");
  },
};

function wait(timeout = 250) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

/**
 * The IO effects sometimes fail due to different external issues - for example, network or filesystem.
 * To make these tests more reliable, we can wrap these effects in the `retry` function.
 */
async function retry<T>(
  effect: () => Promise<T>,
  logger: Logger,
  retries = 3,
  delay = 250
): Promise<T> {
  let lastError: unknown;

  for (let retry = 1; retry <= retries; ++retry) {
    try {
      return await effect();
    } catch (error) {
      logger.log(error.toString());
      logger.log(`Retry ${retry} of ${retries}.`);
      lastError = error;
      await wait(delay);
    }
  }

  throw lastError;
}

async function createSandboxDirectory() {
  return fs.realpathSync.native(await fs.mkdtemp(join(os.tmpdir(), "karton-")));
}

async function createSandbox(logger: Logger = defaultLogger): Promise<Sandbox> {
  const context = await createSandboxDirectory();

  let createdFiles: string[] = [];
  let childProcesses: ChildProcess[] = [];

  async function removeCreatedFiles() {
    await Promise.all(createdFiles.map((path) => sandbox.remove(path)));
    createdFiles = [];
  }

  async function killSpawnedProcesses() {
    await Promise.all(
      childProcesses.map((childProcess) => sandbox.kill(childProcess))
    );
  }

  function normalizeEol(content: string): string {
    return content.split(/\r\n?|\n/).join("\n");
  }

  logger.log(`Sandbox directory: ${context}`);

  const sandbox: Sandbox = {
    context,
    destroy: async () => {
      logger.log("Destroying the sandbox...");

      await killSpawnedProcesses();
      await fs.remove(context);

      logger.log("Sandbox destroyed.\n");
    },
    write: async (path: string, content: string, retries = 3, delay = 250) => {
      logger.log(`Writing file ${path}...`);
      const realPath = join(context, path);
      const dirPath = dirname(realPath);

      if (!createdFiles.includes(path) && !(await fs.pathExists(realPath))) {
        createdFiles.push(path);
      }

      await retry(
        async () => {
          if (!(await fs.pathExists(dirPath))) {
            await fs.mkdirp(dirPath);
          }
        },
        logger,
        retries,
        delay
      );

      // wait to avoid race conditions
      await wait();

      return retry(
        () => fs.writeFile(realPath, normalizeEol(content)),
        logger,
        retries,
        delay
      );
    },
    read: (path: string, retries = 3, delay = 250) => {
      logger.log(`Reading file ${path}...`);
      const realPath = join(context, path);

      return retry(
        () => fs.readFile(realPath, "utf-8").then(normalizeEol),
        logger,
        retries,
        delay
      );
    },
    exists: (path: string) => {
      const realPath = join(context, path);

      return fs.pathExists(realPath);
    },
    remove: async (path: string, retries = 3, delay = 250) => {
      logger.log(`Removing file ${path}...`);
      const realPath = join(context, path);

      // wait for fs events to be propagated
      await wait();

      return retry(() => fs.remove(realPath), logger, retries, delay);
    },
    patch: async (
      path: string,
      search: string,
      replacement: string,
      retries = 3,
      delay = 250
    ) => {
      logger.log(
        `Patching file ${path} - replacing "${search}" with "${replacement}"...`
      );
      const realPath = join(context, path);
      const content = await retry(
        () => fs.readFile(realPath, "utf-8").then(normalizeEol),
        logger
      );

      if (!content.includes(search)) {
        throw new Error(
          `Cannot find "${search}" in the ${path}. The file content:\n${content}.`
        );
      }

      // wait for fs events to be propagated
      await wait();

      return retry(
        () => fs.writeFile(realPath, content.replace(search, replacement)),
        logger,
        retries,
        delay
      );
    },
    exec: (command: string, env = {}, cwd = context) =>
      new Promise<string>((resolve, reject) => {
        logger.log(`Executing "${command}" command...`);

        const childProcess = exec(
          command,
          {
            cwd,
            env: {
              ...process.env,
              ...env,
            },
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(stdout + stderr);
            } else {
              resolve(stdout + stderr);
            }
            childProcesses = childProcesses.filter(
              (aChildProcess) => aChildProcess !== childProcess
            );
          }
        );

        childProcess.stdout?.on("data", (data) =>
          process.stdout.write(stripAnsi(data.toString()))
        );
        childProcess.stderr?.on("data", (data) =>
          process.stdout.write(stripAnsi(data.toString()))
        );

        childProcesses.push(childProcess);
      }),
    spawn: (command: string, env = {}, cwd = context) => {
      logger.log(`Spawning "${command}" command...`);

      const [spawnCommand, ...args] = command.split(" ");

      const childProcess = spawn(spawnCommand, args, {
        cwd,
        env: {
          ...process.env,
          ...env,
        },
      });

      childProcess.stdout?.on("data", (data) =>
        process.stdout.write(stripAnsi(data.toString()))
      );
      childProcess.stderr?.on("data", (data) =>
        process.stdout.write(stripAnsi(data.toString()))
      );
      childProcess.on("exit", () => {
        childProcesses = childProcesses.filter(
          (aChildProcess) => aChildProcess !== childProcess
        );
      });

      childProcesses.push(childProcess);

      return childProcess;
    },
    kill: async (childProcess: ChildProcess, retries = 3, delay = 250) => {
      if (!childProcess.killed && childProcess.pid) {
        logger.log(`Killing child process ${childProcess.pid}...`);
        await retry(
          () =>
            new Promise<void>((resolve) =>
              treeKill(childProcess.pid, "SIGKILL", (error) => {
                if (error) {
                  // we don't want to reject as it's probably some OS issue
                  // or already killed process
                  console.error(error);
                }
                resolve();
              })
            ),
          logger,
          retries,
          delay
        );
        logger.log(`Child process ${childProcess.pid} killed.`);
      }
      childProcesses = childProcesses.filter(
        (aChildProcess) => aChildProcess !== childProcess
      );
    },
  };

  return sandbox;
}

export { Sandbox, createSandbox, Logger, defaultLogger };
