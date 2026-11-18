const assert = require('node:assert/strict');
const { test } = require('node:test');
const ganache = require('ganache');
const solc = require('solc');
const { ethers } = require('ethers');
const { abi, init } = require('../build/contract.json');

test('two identity holders independently acknowledge the same file', async t => {
  const chain = ganache.provider({ logging: { quiet: true } });
  t.after(() => chain.disconnect());
  const provider = new ethers.BrowserProvider(chain);
  provider.pollingInterval = 80;
  const [sender, receiver, other] = await Promise.all([0, 1, 2].map(i => provider.getSigner(i)));
  const a = await sender.getAddress(), b = await receiver.getAddress(), c = await other.getAddress();
  const registryAddress = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
  const mockSource = 'pragma solidity 0.8.30; contract Registry { mapping(address => uint256) public balanceOf; function set(address a,uint256 n) external {balanceOf[a]=n;} }';
  const mock = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'Registry.sol': { content: mockSource } },
    settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } }
  }))).contracts['Registry.sol'].Registry;
  await chain.request({ method: 'evm_setAccountCode', params: [registryAddress, '0x' + mock.evm.deployedBytecode.object] });
  const registry = new ethers.Contract(registryAddress, mock.abi, sender);
  const contract = await new ethers.ContractFactory(abi, init, sender).deploy();
  await contract.waitForDeployment();
  const digest = ethers.sha256(ethers.toUtf8Bytes('Revision 1, approved'));
  const wrongDigest = ethers.sha256(ethers.toUtf8Bytes('Revision 2'));
  async function expectError(promise, name) {
    await assert.rejects(promise, err => err.revert?.name === name);
  }
  await expectError(contract.create.staticCall(b, digest), 'AgentIdRequired');
  await (await registry.set(a, 1)).wait();
  await expectError(contract.create.staticCall(b, digest), 'AgentIdRequired');
  await (await registry.set(b, 1)).wait();
  await expectError(contract.create.staticCall(a, digest), 'InvalidParties');
  await expectError(contract.create.staticCall(ethers.ZeroAddress, digest), 'InvalidParties');
  await expectError(contract.create.staticCall(b, ethers.ZeroHash), 'EmptyDigest');
  await expectError(contract.get(42), 'UnknownReceipt');
  const receipt = await (await contract.create(b, digest)).wait();
  const event = contract.interface.parseLog(receipt.logs[0]);
  assert.deepEqual([...event.args], [1n, a, b, digest]);
  const pending = await contract.get(1);
  assert.equal(pending.state, 1n);
  assert.equal(pending.closedAt, 0n);
  await expectError(contract.connect(other).accept.staticCall(1, digest), 'WrongParty');
  await expectError(contract.connect(receiver).cancel.staticCall(1), 'WrongParty');
  await expectError(contract.connect(receiver).accept.staticCall(1, wrongDigest), 'DigestMismatch');
  await (await registry.set(b, 0)).wait();
  await expectError(contract.connect(receiver).accept.staticCall(1, digest), 'AgentIdRequired');
  await (await registry.set(b, 1)).wait();
  await (await contract.connect(receiver).accept(1, digest)).wait();
  const accepted = await contract.get(1);
  assert.equal(accepted.state, 2n);
  assert.equal(accepted.digest, digest);
  assert.ok(accepted.closedAt >= accepted.openedAt);
  await expectError(contract.cancel.staticCall(1), 'NotPending');
  await expectError(contract.connect(receiver).accept.staticCall(1, digest), 'NotPending');
  await (await contract.create(b, digest)).wait();
  await (await contract.cancel(2)).wait();
  assert.equal((await contract.get(2)).state, 3n);
  await expectError(contract.connect(receiver).accept.staticCall(2, digest), 'NotPending');
  assert.equal(await contract.count(), 2n);
  assert.notEqual(a, c);
});
