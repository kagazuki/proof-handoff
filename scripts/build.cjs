const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const file = 'contracts/ProofHandoff.sol';
const input = {
  language: 'Solidity',
  sources: { [file]: { content: fs.readFileSync(file, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
};
const result = JSON.parse(solc.compile(JSON.stringify(input)));
for (const issue of result.errors || []) {
  if (issue.severity === 'error') throw new Error(issue.formattedMessage);
}
const contract = result.contracts[file].ProofHandoff;
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/standard-input.json', JSON.stringify(input, null, 2));
fs.writeFileSync('build/contract.json', JSON.stringify({
  compiler: solc.version(), abi: contract.abi, init: '0x' + contract.evm.bytecode.object,
  runtime: '0x' + contract.evm.deployedBytecode.object
}, null, 2));
const ethersRoot = path.resolve(path.dirname(require.resolve('ethers')), '..');
fs.mkdirSync('web/vendor', { recursive: true });
fs.copyFileSync(path.join(ethersRoot, 'dist/ethers.umd.min.js'), 'web/vendor/ethers.umd.min.js');
fs.copyFileSync(path.join(ethersRoot, 'LICENSE.md'), 'web/vendor/ethers-LICENSE.md');
console.log('Compiler', solc.version(), '| Runtime bytes', contract.evm.deployedBytecode.object.length / 2);
