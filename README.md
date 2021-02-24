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
  packLocalPackage,
  externalPackage, 
  Package
} from "karton";
import path from 'path';

describe('my-package', () => {
  let sandbox: Sandbox;
  let myPackage: Package;

  beforeAll(async () => {
    myPackage = await packLocalPackage(
      path.resolve(__dirname, '../../')
    );
    sandbox = await createSandbox();
  });
  afterEach(async () => {
    await sandbox.reset();
  });
  afterAll(async () => {
    await sandbox.cleanup();
  })

  it.each([
    externalPackage('webpack', '^4.0.0'),
    externalPackage('webpack', '^5.0.0')
  ])('works with webpack %p', async (webpack) => {
    await sandbox.load(path.join(__dirname, 'fixtures/basic'));
    await sandbox.install('yarn', [myPackage, webpack]);
    const result = await sandbox.exec('node src/test.js');
    
    expect(result).toEqual('my-package awesome output');
  });
})
```

## License
MIT
