<div align="center">

<h1>karton </h1>
<p>Test your package in a sandbox 📦</p>
<p>⚠️ In development ⚠️</p>

</div>

## Installation

This package requires minimum Node.js 10

```sh
# with npm
npm install --save-dev karton

# with yarn
yarn add --dev karton
```

## Usage

This package helps you with writing E2E tests for your packages.
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
    sandbox = await createSandbox({
      lockDirectory: path.resolve(__dirname, '__locks__'),
      fixedDependencies: {
        'my-package': `file:${await packLocalPackage(
          path.resolve(__dirname, '../../')
        )}`
      }
    });
  });
  afterEach(async () => {
    await sandbox.reset();
  });
  afterAll(async () => {
    await sandbox.cleanup();
  })

  it.each([
    [{ 'webpack': '^4.0.0' }],
    [{ 'webpack': '^5.0.0' }]
  ])('works with %p', async (dependencies) => {
    await sandbox.load(path.join(__dirname, 'fixtures/basic'));
    await sandbox.install('yarn', dependencies);
    const result = await sandbox.exec('node src/test.js');
    
    expect(result).toEqual('my-package awesome output');
  });
})
```

## License
MIT
