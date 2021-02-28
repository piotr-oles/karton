import { resolve, dirname } from "path";
import fs from "fs-extra";
import os from "os";
import crypto from "crypto";
import { exec, ChildProcess } from "child_process";
import spawn from "cross-spawn";
import stripAnsi from "strip-ansi";
import treeKill from "tree-kill";
import { defaultLogger, Logger } from "./logger";
import { retry, RetryOptions, wait } from "./async";

interface SandboxOptions {
  logger?: Logger;
  lockDirectory?: string;
  fixedDependencies?: Record<string, string>;
}

interface ExecOptions extends RetryOptions {
  cwd?: string;
  env?: Record<string, string>;
  fail?: boolean;
}

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

type BufferEncoding =
  | "ascii"
  | "utf8"
  | "utf-8"
  | "utf16le"
  | "ucs2"
  | "ucs-2"
  | "base64"
  | "latin1"
  | "binary"
  | "hex";

interface Sandbox {
  context: string;
  reset(options?: RetryOptions): Promise<void>;
  cleanup(options?: RetryOptions): Promise<void>;
  load(directory: string, options?: RetryOptions): Promise<void>;
  install(
    manager: "yarn" | "npm",
    dependencies: Record<string, string>,
    options?: RetryOptions
  ): Promise<void>;
  write(
    path: string,
    content: string | Buffer,
    options?: RetryOptions
  ): Promise<void>;
  read(
    path: string,
    encoding: BufferEncoding,
    options?: RetryOptions
  ): Promise<string>;
  read(path: string, options?: RetryOptions): Promise<Buffer>;
  exists(path: string, options?: RetryOptions): Promise<boolean>;
  remove(path: string, options?: RetryOptions): Promise<void>;
  patch(
    path: string,
    search: string,
    replacement: string,
    options?: RetryOptions
  ): Promise<void>;
  list(path: string, options?: RetryOptions): Promise<fs.Dirent[]>;
  exec(command: string, options?: ExecOptions): Promise<string>;
  spawn(command: string, options?: SpawnOptions): ChildProcess;
  kill(childProcess: ChildProcess, options?: RetryOptions): Promise<void>;
}

function normalizeEol(content: string): string {
  return content.split(/\r\n?|\n/).join("\n");
}

async function createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const {
    logger = defaultLogger,
    fixedDependencies = {},
    lockDirectory,
  } = options;

  const context = fs.realpathSync.native(
    await fs.mkdtemp(resolve(os.tmpdir(), "karton-sandbox-"))
  );
  logger.log(`Sandbox directory: ${context}`);

  const childProcesses = new Set<ChildProcess>();

  const sandbox: Sandbox = {
    context,
    reset: async (options?: RetryOptions) => {
      logger.log("Resetting the sandbox...");

      // kill all processes
      await Promise.all(
        Array.from(childProcesses).map((childProcess) =>
          sandbox.kill(childProcess, options)
        )
      );
      // remove all files/dirs, except node_modules
      await Promise.all(
        (await fs.readdir(context))
          // keep node_modules for caching
          .filter((entry) => entry !== "node_modules")
          .map((entry) =>
            retry(() => fs.remove(resolve(context, entry)), logger, options)
          )
      );

      logger.log(`Sandbox reset.\n`);
    },
    cleanup: async (options?: RetryOptions) => {
      logger.log("Cleaning up the sandbox...");

      // kill all processes
      await Promise.all(
        Array.from(childProcesses).map((childProcess) =>
          sandbox.kill(childProcess, options)
        )
      );
      // remove sandbox directory
      await retry(() => fs.remove(context), logger, options);

      logger.log("Sandbox cleaned up.\n");
    },
    load: async (directory: string, options?: RetryOptions) => {
      return retry(() => fs.copy(directory, context), logger, options);
    },
    install: async (
      manager: "yarn" | "npm",
      dependencies: Record<string, string>,
      options?: RetryOptions
    ) => {
      logger.log("Installing dependencies...");

      if (!(await sandbox.exists("package.json", options))) {
        throw new Error(
          "Cannot install dependencies - missing package.json in sandbox."
        );
      }

      const originalPackageJSON = JSON.parse(
        await sandbox.read("package.json", "utf8", options)
      );
      const packageJSON = {
        ...originalPackageJSON,
        dependencies: {
          ...(originalPackageJSON.dependencies || {}),
          ...fixedDependencies,
          ...dependencies,
        },
      };
      await sandbox.write(
        "package.json",
        JSON.stringify(packageJSON, undefined, "  "),
        options
      );

      let lockFile: string | undefined;
      if (lockDirectory) {
        lockFile = resolve(
          lockDirectory,
          `${crypto
            .createHash("md5")
            .update(
              JSON.stringify([
                manager,
                dependencies,
                originalPackageJSON.dependencies,
                originalPackageJSON.devDependencies,
              ])
            )
            .digest("hex")}.lock`
        );
      }

      const tryToLoadLockFile = async (managerFile: string) => {
        if (lockFile && (await fs.pathExists(lockFile))) {
          await sandbox.write(
            managerFile,
            await fs.readFile(lockFile, "utf-8")
          );
        }
      };

      const tryToStoreLockFile = async (managerFile: string) => {
        if (lockFile && (await sandbox.exists(managerFile))) {
          const lockFileDir = dirname(lockFile);
          await retry(
            async () => {
              if (!(await fs.pathExists(lockFileDir))) {
                await fs.mkdirp(lockFileDir);
              }
            },
            logger,
            options
          );

          await retry(
            async () =>
              fs.writeFile(lockFile!, await sandbox.read(managerFile)),
            logger,
            options
          );
        }
      };

      switch (manager) {
        case "yarn":
          await tryToLoadLockFile("yarn.lock");
          await sandbox.exec(`yarn install`, options);
          await tryToStoreLockFile("yarn.lock");
          break;
        case "npm":
          await tryToLoadLockFile("package-lock.json");
          await sandbox.exec(`npm install`, options);
          await tryToStoreLockFile("package-lock.json");
          break;
      }
    },
    write: async (
      path: string,
      content: string | Buffer,
      options?: RetryOptions
    ) => {
      logger.log(`Writing file ${path}...`);
      const realPath = resolve(context, path);
      const dirPath = dirname(realPath);

      await retry(
        async () => {
          if (!(await fs.pathExists(dirPath))) {
            await fs.mkdirp(dirPath);
          }
        },
        logger,
        options
      );

      // wait to avoid race conditions
      await wait();

      return retry(
        () =>
          fs.writeFile(
            realPath,
            typeof content === "string" ? normalizeEol(content) : content
          ),
        logger,
        options
      );
    },
    read: (
      path: string,
      encodingOrOptions?: BufferEncoding | RetryOptions,
      options?: RetryOptions
    ): Promise<string> | Promise<Buffer> => {
      logger.log(`Reading file ${path}...`);

      if (typeof encodingOrOptions === "string") {
        return retry<string>(
          () =>
            fs
              .readFile(resolve(context, path), encodingOrOptions)
              .then(normalizeEol),
          logger,
          options
        );
      } else {
        return retry(
          () => fs.readFile(resolve(context, path)),
          logger,
          options
        );
      }
    },
    exists: (path: string) => fs.pathExists(resolve(context, path)),
    remove: (path: string, options?: RetryOptions) => {
      logger.log(`Removing file ${path}...`);

      return retry(() => fs.remove(resolve(context, path)), logger, options);
    },
    patch: async (
      path: string,
      search: string,
      replacement: string,
      options?: RetryOptions
    ) => {
      logger.log(
        `Patching file ${path} - replacing "${search}" with "${replacement}"...`
      );
      const realPath = resolve(context, path);
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
        options
      );
    },
    list: (path: string, options?: RetryOptions) =>
      retry(
        () => fs.readdir(resolve(context, path), { withFileTypes: true }),
        logger,
        options
      ),
    exec: (command: string, options: ExecOptions = {}) =>
      retry(
        () =>
          new Promise<string>((resolve, reject) => {
            logger.log(`Executing "${command}" command...`);

            const env = options.env || {};
            const cwd = options.cwd || context;

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
                const results = stripAnsi(stdout + stderr);
                if ((error && options.fail) || !error) {
                  resolve(results);
                } else {
                  reject(results);
                }
                childProcesses.delete(childProcess);
              }
            );

            childProcess.stdout?.on("data", (data) =>
              process.stdout.write(stripAnsi(data.toString()))
            );
            childProcess.stderr?.on("data", (data) =>
              process.stdout.write(stripAnsi(data.toString()))
            );

            childProcesses.add(childProcess);
          }),
        logger,
        options
      ),
    spawn: (command: string, options: SpawnOptions = {}) => {
      logger.log(`Spawning "${command}" command...`);

      const env = options.env || {};
      const cwd = options.cwd || context;
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
        childProcesses.delete(childProcess);
      });

      childProcesses.add(childProcess);

      return childProcess;
    },
    kill: async (childProcess: ChildProcess, options?: RetryOptions) => {
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
          options
        );
        logger.log(`Child process ${childProcess.pid} killed.`);
      }
      childProcesses.delete(childProcess);
    },
  } as Sandbox;

  return sandbox;
}

export { Sandbox, createSandbox };
