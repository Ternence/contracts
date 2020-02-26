const { expect } = require('chai');
const {
  BN,
  send,
  balance,
  ether,
  expectEvent
} = require('@openzeppelin/test-helpers');
const { deployAllProxies } = require('../../deployments');
const {
  getNetworkConfig,
  deployLogicContracts
} = require('../../deployments/common');
const { initialSettings } = require('../../deployments/settings');
const { deployVRC } = require('../../deployments/vrc');
const {
  removeNetworkFile,
  registerValidator,
  validatorRegistrationArgs,
  getCollectorEntityId
} = require('../common/utils');
const { testCases } = require('./withdrawalTestCases');

const WalletsRegistry = artifacts.require('WalletsRegistry');
const Withdrawals = artifacts.require('Withdrawals');
const Operators = artifacts.require('Operators');
const WalletsManagers = artifacts.require('WalletsManagers');
const Settings = artifacts.require('Settings');
const ValidatorTransfers = artifacts.require('ValidatorTransfers');
const Privates = artifacts.require('Privates');
const Pools = artifacts.require('Pools');

const validatorDepositAmount = new BN(initialSettings.validatorDepositAmount);
const stakingDuration = new BN('31536000');

contract('Privates (transferred withdrawal)', ([_, ...accounts]) => {
  let networkConfig,
    privates,
    pools,
    settings,
    walletsRegistry,
    withdrawals,
    vrc,
    validatorTransfers;
  let [
    admin,
    operator,
    walletsManager,
    other,
    sender,
    ...otherAccounts
  ] = accounts;

  before(async () => {
    networkConfig = await getNetworkConfig();
    await deployLogicContracts({ networkConfig });
    vrc = await deployVRC({ from: admin });
  });

  after(() => {
    removeNetworkFile(networkConfig.network);
  });

  beforeEach(async () => {
    let proxies = await deployAllProxies({
      initialAdmin: admin,
      networkConfig,
      vrc: vrc.options.address
    });
    let operators = await Operators.at(proxies.operators);
    await operators.addOperator(operator, { from: admin });

    let walletsManagers = await WalletsManagers.at(proxies.walletsManagers);
    await walletsManagers.addManager(walletsManager, { from: admin });

    // set staking duration
    settings = await Settings.at(proxies.settings);
    await settings.setStakingDuration(proxies.privates, stakingDuration, {
      from: admin
    });

    validatorTransfers = await ValidatorTransfers.at(
      proxies.validatorTransfers
    );
    privates = await Privates.at(proxies.privates);
    pools = await Pools.at(proxies.pools);
    withdrawals = await Withdrawals.at(proxies.withdrawals);
    walletsRegistry = await WalletsRegistry.at(proxies.walletsRegistry);
  });

  it('user can withdraw deposit and reward from transferred validator', async () => {
    for (const [
      testCaseN,
      { validatorReturn, maintainerFee, userDeposit, userReward }
    ] of testCases.entries()) {
      // set maintainer's fee
      await settings.setMaintainerFee(maintainerFee, { from: admin });

      // User performs deposit equal to validator deposit amount
      await privates.addDeposit(otherAccounts[0], {
        from: sender,
        value: userDeposit
      });

      // Register validator
      let validatorId = await registerValidator({
        args: validatorRegistrationArgs[testCaseN],
        hasReadyEntity: true,
        privatesProxy: privates.address,
        operator
      });

      // add new entity for transfer
      // can only transfer to pool collector
      await pools.addDeposit(other, {
        from: other,
        value: validatorDepositAmount
      });

      // transfer validator to the new entity
      await pools.transferValidator(
        validatorId,
        validatorReturn.sub(validatorDepositAmount),
        {
          from: operator
        }
      );
      let collectorEntityId = getCollectorEntityId(
        privates.address,
        testCaseN + 1
      );

      // track user's balance
      let userBalance = await balance.tracker(otherAccounts[0]);

      // User withdraws deposit
      let receipt = await validatorTransfers.withdraw(
        collectorEntityId,
        otherAccounts[0],
        {
          from: sender
        }
      );
      expectEvent(receipt, 'UserWithdrawn', {
        collectorEntityId,
        sender: sender,
        withdrawer: otherAccounts[0],
        depositAmount: userDeposit,
        rewardAmount: new BN(0)
      });

      // User's balance has changed
      expect(await userBalance.delta()).to.be.bignumber.equal(userDeposit);

      // ValidatorTransfers is empty
      expect(
        await balance.current(validatorTransfers.address)
      ).to.be.bignumber.equal(new BN(0));

      // assign wallet
      const { logs } = await walletsRegistry.assignWallet(validatorId, {
        from: walletsManager
      });
      let wallet = logs[0].args.wallet;

      // enable withdrawals
      await send.ether(other, wallet, validatorReturn.add(ether('1')));
      await withdrawals.enableWithdrawals(wallet, {
        from: walletsManager
      });

      // User withdraws reward
      receipt = await validatorTransfers.withdraw(
        collectorEntityId,
        otherAccounts[0],
        {
          from: sender
        }
      );
      expectEvent(receipt, 'UserWithdrawn', {
        collectorEntityId,
        sender: sender,
        withdrawer: otherAccounts[0],
        depositAmount: new BN(0),
        rewardAmount: userReward
      });

      // User's balance has changed
      expect(await userBalance.delta()).to.be.bignumber.equal(userReward);

      // ValidatorTransfers is empty
      expect(
        await balance.current(validatorTransfers.address)
      ).to.be.bignumber.equal(new BN(0));
    }
  });
});
