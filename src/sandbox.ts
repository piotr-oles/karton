import { resolve, dirname } from "path";
import fs from "fs-extra";
import os from "os";
import crypto from "crypto";
import { exec, ChildProcess } from "child_process";
import spawn from "cross-spawn";
import stripAnsi from "strip-ansi";
import treeKill from "tree-kill";
import { defaultLogger, Logger } from "./logger";
import { Package } from "./package";
import { retry, RetryOptions, wait } from "./async";

interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
}

interface InstallOptions {
  lockDirectory?: string;
}

interface Sandbox {
  context: string;
  reset(options?: RetryOptions): Promise<void>;
  cleanup(options?: RetryOptions): Promise<void>;
  load(directory: string, options?: RetryOptions): Promise<void>;
  install(
    manager: "yarn" | "npm",
    overwrites: Package[],
    options?: InstallOptions & RetryOptions
  ): Promise<void>;
  write(path: string, content: string, options?: RetryOptions): Promise<void>;
  read(path: string, options?: RetryOptions): Promise<string>;
  exists(path: string, options?: RetryOptions): Promise<boolean>;
  remove(path: string, options?: RetryOptions): Promise<void>;
  patch(
    path: string,
    search: string,
    replacement: string,
    options?: RetryOptions
  ): Promise<void>;
  exec(
    command: string,
    options?: CommandOptions & RetryOptions
  ): Promise<string>;
  spawn(command: string, options?: CommandOptions): ChildProcess;
  kill(childProcess: ChildProcess, options?: RetryOptions): Promise<void>;
}

function normalizeEol(content: string): string {
  return content.split(/\r\n?|\n/).join("\n");
}

async function createSandbox(logger: Logger = defaultLogger): Promise<Sandbox> {
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
      overwrites: Package[],
      options?: InstallOptions & RetryOptions
    ) => {
      logger.log("Installing dependencies...");

      if (!(await sandbox.exists("package.json", options))) {
        throw new Error(
          "Cannot install dependencies - missing package.json in sandbox."
        );
      }

      const originalPackageJSON = JSON.parse(
        await sandbox.read("package.json", options)
      );
      const packageJSON = {
        ...originalPackageJSON,
        dependencies: originalPackageJSON.dependencies || {},
      };
      for (const { name, version } of overwrites) {
        packageJSON.dependencies[name] = version;
      }
      await sandbox.write(
        "package.json",
        JSON.stringify(packageJSON, undefined, "  "),
        options
      );

      let lockFile: string | undefined;
      if (options?.lockDirectory) {
        lockFile = resolve(
          options.lockDirectory,
          `${crypto
            .createHash("md5")
            .update(
              JSON.stringify([
                manager,
                overwrites.filter((pkg) => pkg.immutable),
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
          await sandbox.exec(`yarn install --prefer-offline`, options);
          await tryToStoreLockFile("yarn.lock");
          break;
        case "npm":
          await tryToLoadLockFile("package-lock.json");
          await sandbox.exec(`npm install`, options);
          await tryToStoreLockFile("package-lock.json");
          break;
      }
    },
    write: async (path: string, content: string, options?: RetryOptions) => {
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
        () => fs.writeFile(realPath, normalizeEol(content)),
        logger,
        options
      );
    },
    read: (path: string, options?: RetryOptions) => {
      logger.log(`Reading file ${path}...`);

      return retry(
        () => fs.readFile(resolve(context, path), "utf-8").then(normalizeEol),
        logger,
        options
      );
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
    exec: (command: string, options: CommandOptions & RetryOptions = {}) =>
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
                if (error) {
                  reject(stdout + stderr);
                } else {
                  resolve(stdout + stderr);
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
    spawn: (command: string, options: CommandOptions = {}) => {
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
  };

  return sandbox;
}

export { Sandbox, createSandbox };
