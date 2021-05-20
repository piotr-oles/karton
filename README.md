<div align="center">

<h1>karton</h1>
<p>Test your package in a sandbox 📦</p>
<p>⚠️ In development ⚠️</p>

</div>

## Features
 * Suited for E2E tests of Node packages 👩‍💻
 * Tests integration with different versions of dependencies 🔗
 * Handles OS quirks (Windows, Linux, Mac OS) 🐛
 * Created for speed (caches lock files, re-uses sandbox between tests) 🏎
 
## Installation

This package requires minimum Node.js 10.

```sh
# with npm
npm install --save-dev karton

# with yarn
yarn add --dev karton
```

## Usage

The karton is a set of utilities that helps writing E2E tests for Node packges.

Let's say you want to test if your library works with different versions of dependencies.
With karton, you can define list of versions directly in the test file.

The process is following:
 1. *beforeAll*: Create a new sandbox - `createSandbox()` (it's a directory in temp in which you will perform tests)
 2. Load fixtures into sandbox - `sandbox.load()` (simply copies files from fixture directory to the sandbox)
 3. Install dependencies inside the sandbox - `sandbox.install()`
 4. Perform tests (modify files, exec commands, examine output)
 5. *afterEach*: Reset sandbox for the next test - `sandbox.reset()`
 6. *afterAll*: Cleanup sandbox - `sandbox.cleanup()`

Example:

```typescript
import { 
  createSandbox,
  Sandbox, 
  packLocalPackage
} from "karton";
import path from 'path';

describe('my-package', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    // pack local package into tar file to make it installable
    const myPackageTar = await packLocalPackage(
      path.resolve(__dirname, '../../')
    );

    // create a new sandbox for this tests suite
    sandbox = await createSandbox({
      // optional: directory in which you can cache lock files
      // if you use it, make sure to .gitignore that directory
      lockDirectory: path.resolve(__dirname, '__locks__'),
      // list of dependencies that should not change between tests
      fixedDependencies: {
        'my-package': `file:${myPackageTar}`
      }
    });
  });
  afterEach(async () => {
    // reset sandbox after each test - it will keep node_modules for faster installs
    await sandbox.reset();
  });
  afterAll(async () => {
    // cleanup sandbox after all tests - it will remove the whole directory
    await sandbox.cleanup();
  })

  it.each([
    [{ 'webpack': '^4.0.0' }],
    [{ 'webpack': '^5.0.0' }]
  ])('works with %p', async (dependencies) => {
    // load fixture from the fixtures/basic directory
    await sandbox.load(path.join(__dirname, 'fixtures/basic'));
    // install dependencies using yarn
    await sandbox.install('yarn', dependencies);
    // run src/test.js script and store stdout + stderr in the result variable
    const result = await sandbox.exec('node src/test.js');
    
    // test if result is correct
    expect(result).toEqual('my-package awesome output');
  });
})
```

## License
MIT
