import { exec } from "child_process";
import stripAnsi from "strip-ansi";
import path from "path";
import fs from "fs-extra";
import os from "os";

interface Package {
  name: string;
  version: string;
  immutable?: boolean;
}

function externalPackage(name: string, version: string): Package {
  const pkg = { name, version, immutable: true };
  Object.assign(pkg, {
    toString: () => `${pkg.name}@${pkg.version}`,
  });
  return pkg;
}

async function packLocalPackage(directory: string): Promise<Package> {
  const packageJSONPath = path.resolve(directory, "package.json");
  if (!(await fs.pathExists(packageJSONPath))) {
    throw new Error(
      `Cannot pack package - missing package.json file in ${directory} directory.`
    );
  }
  const { name, version } = JSON.parse(
    await fs.readFile(packageJSONPath, "utf-8")
  );
  const npmPacked = path.resolve(directory, `${name}-${version}.tgz`);

  return new Promise<Package>((resolve, reject) => {
    const childProcess = exec(
      "npm pack",
      {
        cwd: directory,
        env: process.env,
      },
      async (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr));
        } else {
          if (await fs.pathExists(npmPacked)) {
            // move package to unique dir to avoid caching in dev environment
            const packagePath = path.resolve(
              fs.realpathSync.native(
                await fs.mkdtemp(path.resolve(os.tmpdir(), "karton-package-"))
              ),
              path.basename(npmPacked)
            );

            await fs.move(npmPacked, packagePath);

            const pkg = {
              name,
              version: `file:${packagePath}`,
              immutable: false,
            };
            Object.assign(pkg, {
              toString: () => `${name}@${version}`,
            });
            resolve(pkg);
          } else {
            reject(
              new Error(`Cannot find 'npm pack' output file: ${npmPacked}`)
            );
          }
        }
      }
    );

    childProcess.stdout?.on("data", (data) =>
      process.stdout.write(stripAnsi(data.toString()))
    );
    childProcess.stderr?.on("data", (data) =>
      process.stdout.write(stripAnsi(data.toString()))
    );
  });
}

export { externalPackage, packLocalPackage, Package };
