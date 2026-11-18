const { ethers } = require('ethers');
const { init, runtime } = require('../build/contract.json');

const factory = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const factoryCode = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const salt = ethers.id('Proof Handoff / BSC / v1');

async function inspect() {
  const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org');
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error('Unexpected chain');
  if ((await provider.getCode(factory)) !== factoryCode) throw new Error('Factory bytecode mismatch');
  const address = ethers.getCreate2Address(factory, salt, ethers.keccak256(init));
  const existing = await provider.getCode(address);
  if (existing !== '0x' && existing !== runtime) throw new Error('Unexpected runtime at destination');
  const data = ethers.concat([salt, init]);
  const result = { chainId: 56, factory, address, data, deployed: existing === runtime };
  if (!result.deployed) {
    const request = { to: factory, data, value: 0n };
    const returned = await provider.call(request);
    if (returned.toLowerCase() !== address.toLowerCase()) throw new Error('Factory returned unexpected address');
    const gas = await provider.estimateGas(request);
    const price = (await provider.getFeeData()).gasPrice;
    Object.assign(result, { gas: gas.toString(), price: price.toString(), feeBNB: ethers.formatEther(gas * price) });
  }
  return result;
}

module.exports = { inspect };
if (require.main === module) inspect().then(({ data, ...summary }) => console.log(summary)).catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
