<div align="center">

<h1>karton </h1>
<p>Create sandbox for E2E tests 📦</p>

</div>

## Installation

This loader requires minimum Node.js 10

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
import { createSandbox, Sandbox } from "karton";
import path from 'path';
import fs from 'fs-extra';

describe('my-package', () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandbox();
  });
  afterEach(async () => {
    await sandbox.destroy();
  });

  it.each([
    '^4.0.0',
    '^5.0.0'
  ])('works with webpack %p', async (webpackVersion) => {
    const packageJSON = JSON.parse(
      await fs.readFile('fixtures/package.json', 'utf-8')
    );
    packageJSON.dependencies['webpack'] = webpackVersion;
    packageJSON.dependencies['my-package'] = path.resolve(__dirname, '../my-package-0.0.0.tgz');
  
    await sandbox.write('package.json', JSON.stringify(packageJSON));
    await sandbox.write('src/test.js', await fs.readFile('fixtures/src/test.js'));
        
    await sandbox.exec('yarn install');
    const result = await sandbox.exec('node src/test.js');
    
    expect(result).toEqual('my-package awesome output');
  });
})
```

## License
MIT
