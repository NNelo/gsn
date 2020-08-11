import Web3 from 'web3'
import { BlockNumber, Log, PastLogsOptions, provider, Transaction, TransactionReceipt } from 'web3-core'
import { EventData, PastEventOptions } from 'web3-eth-contract'
import { PrefixedHexString, TransactionOptions } from 'ethereumjs-tx'

import RelayRequest from '../common/EIP712/RelayRequest'
import paymasterAbi from '../common/interfaces/IPaymaster.json'
import relayHubAbi from '../common/interfaces/IRelayHub.json'
import forwarderAbi from '../common/interfaces/ITrustedForwarder.json'
import stakeManagerAbi from '../common/interfaces/IStakeManager.json'
import gsnRecipientAbi from '../common/interfaces/IRelayRecipient.json'
import knowForwarderAddressAbi from '../common/interfaces/IKnowForwarderAddress.json'

import { event2topic } from '../common/utils'
import replaceErrors from '../common/ErrorReplacerJSON'

import { Address, IntString } from './types/Aliases'
import { GSNConfig } from './GSNConfigurator'
import GsnTransactionDetails from './types/GsnTransactionDetails'
import { BlockTransactionString } from 'web3-eth'
import Common from 'ethereumjs-common'

type EventName = string

export const RelayServerRegistered: EventName = 'RelayServerRegistered'
export const StakeUnlocked: EventName = 'StakeUnlocked'
export const HubUnauthorized: EventName = 'HubUnauthorized'
export const StakePenalized: EventName = 'StakePenalized'

export default class ContractInteractorWeb3 {
  private readonly IPaymasterContract: any
  private readonly IRelayHubContract: any
  private readonly IForwarderContract: any
  private readonly IStakeManager: any
  private readonly IRelayRecipient: any
  private readonly IKnowForwarderAddress: any

  private readonly web3: Web3
  private readonly provider: provider
  private readonly config: GSNConfig
  private rawTxOptions?: TransactionOptions
  private chainId?: number
  private networkId?: number
  private networkType?: string

  constructor (provider: provider, config: GSNConfig) {
    this.web3 = new Web3(provider)
    this.config = config
    this.provider = provider
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Web3EthContract = require('web3-eth-contract')
    Web3EthContract.setProvider(this.web3)
    this.IPaymasterContract = new Web3EthContract(
      paymasterAbi
    )
    this.IRelayHubContract = new Web3EthContract(
      relayHubAbi
    )
    this.IForwarderContract = new Web3EthContract(
      forwarderAbi
    )
    this.IStakeManager = new Web3EthContract(
      stakeManagerAbi
    )
    this.IRelayRecipient = new Web3EthContract(
      gsnRecipientAbi
    )
    this.IKnowForwarderAddress = new Web3EthContract(
      knowForwarderAddressAbi
    )
  }

  getProvider (): provider { return this.provider }

  getWeb3 (): Web3 { return this.web3 }

  async _init (): Promise<void> {
    const chain = await this.web3.eth.net.getNetworkType()
    console.log('== chain =', chain)
    this.chainId = await this.web3.eth.getChainId()
    this.networkId = await this.web3.eth.net.getId()
    this.networkType = await this.web3.eth.net.getNetworkType()
    // chain === 'private' means we're on ganache, and ethereumjs-tx.Transaction doesn't support that chain type
    this.rawTxOptions = getRawTxOptions(this.chainId, this.networkId, chain !== 'private' ? chain : 'mainnet')
  }

  // must use these options when creating Transaction object
  getRawTxOptions (): TransactionOptions {
    if (this.rawTxOptions == null) {
      console.log('ContractInteractorWeb3 :: getRawTxOptions : init not called')
      throw new Error('_init not called')
    }
    return this.rawTxOptions
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createKnowsForwarder (address: Address): Promise<any> {
    await (this.IKnowForwarderAddress.options.address = address)
    return this.IKnowForwarderAddress
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createRecipient (address: Address): Promise<any> {
    await (this.IRelayRecipient.options.address = address)
    return this.IRelayRecipient
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createPaymaster (address: Address): Promise<any> {
    await (this.IPaymasterContract.options.address = address)
    return this.IPaymasterContract
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createRelayHub (address: Address): Promise<any> {
    await (this.IRelayHubContract.options.address = address)
    return this.IRelayHubContract
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createForwarder (address: Address): Promise<any> {
    await (this.IForwarderContract.options.address = address)
    return this.IForwarderContract
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _createStakeManager (address: Address): Promise<any> {
    await (this.IStakeManager.options.address = address)
    return this.IStakeManager
  }

  async getForwarder (recipientAddress: Address): Promise<Address> {
    const recipient = await this._createKnowsForwarder(recipientAddress)
    const trustedForwarder = await recipient.methods.getTrustedForwarder().call()
    return trustedForwarder
  }

  async isTrustedForwarder (recipientAddress: Address, forwarder: Address): Promise<boolean> {
    const recipient = await this._createRecipient(recipientAddress)
    console.log('isTrustedForwarder : forwarder', forwarder)
    console.log('isTrustedForwarder : recipient address', recipientAddress);
    const isTrusted = await recipient.methods.isTrustedForwarder(forwarder).call()
    console.log('isTrustedForwarder : isTrusted', isTrusted)
    return isTrusted
  }

  async getSenderNonce (sender: Address, forwarderAddress: Address): Promise<IntString> {
    const forwarder = await this._createForwarder(forwarderAddress)
    const nonce = await forwarder.methods.getNonce(sender).call()
    return nonce.toString()
  }

  async validateAcceptRelayCall (
    relayRequest: RelayRequest,
    signature: PrefixedHexString,
    approvalData: PrefixedHexString): Promise<{ paymasterAccepted: boolean, returnValue: string, reverted: boolean }> {
    const relayHub = await this._createRelayHub(this.config.relayHubAddress)
    try {
      const res = await relayHub.methods.relayCall(
          relayRequest,
          signature,
          approvalData
      )
        .call({
          from: relayRequest.relayData.relayWorker,
          gasPrice: relayRequest.gasData.gasPrice
        })
      if (this.config.verbose) {
        console.log(res)
      }
      return {
        returnValue: res.returnValue,
        paymasterAccepted: res.paymasterAccepted,
        reverted: false
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        paymasterAccepted: false,
        reverted: true,
        returnValue: `view call to 'relayCall' reverted in client (should not happen): ${message}`
      }
    }
  }

  encodeABI (relayRequest: RelayRequest, sig: PrefixedHexString, approvalData: PrefixedHexString): PrefixedHexString {
    // TODO: check this works as expected
    // @ts-ignore
    console.log('inside encodeABI')
    const relayHub = this.IRelayHubContract.clone()
    console.log('after encodeABI clone')
    return relayHub.methods.relayCall(relayRequest, sig, approvalData).encodeABI()
  }

  topicsForManagers (relayManagers: Address[]): string[] {
    return Array.from(relayManagers.values(),
      (address: Address) => `0x${address.replace(/^0x/, '').padStart(64, '0').toLowerCase()}`
    )
  }

  async getPastEventsForHub (names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const relayHub = await this._createRelayHub(this.config.relayHubAddress)
    return this._getPastEvents(relayHub, names, extraTopics, options)
  }

  async getPastEventsForStakeManager (names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const stakeManager = await this._createStakeManager(this.config.stakeManagerAddress)
    return this._getPastEvents(stakeManager, names, extraTopics, options)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _getPastEvents (contract: any, names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const topics: string[][] = []
    const eventTopic = event2topic(contract, names)
    topics.push(eventTopic)
    if (extraTopics.length > 0) {
      topics.push(extraTopics)
    }
    return contract.getPastEvents('allEvents', Object.assign({}, options, { topics }))
  }

  async getPastLogs (options: PastLogsOptions): Promise<Log[]> {
    return this.web3.eth.getPastLogs(options)
  }

  async getBalance (address: Address): Promise<string> {
    return this.web3.eth.getBalance(address)
  }

  async getBlockNumber (): Promise<number> {
    return this.web3.eth.getBlockNumber()
  }

  async sendSignedTransaction (rawTx: string): Promise<TransactionReceipt> {
    return this.web3.eth.sendSignedTransaction(rawTx)
  }

  async estimateGas (gsnTransactionDetails: GsnTransactionDetails): Promise<number> {
    return this.web3.eth.estimateGas(gsnTransactionDetails)
  }

  async getGasPrice (): Promise<string> {
    return this.web3.eth.getGasPrice()
  }

  async getTransactionCount (address: string, defaultBlock?: BlockNumber): Promise<number> {
    // @ts-ignore (web3 does not define 'defaultBlock' as optional)
    return this.web3.eth.getTransactionCount(address, defaultBlock)
  }

  async getTransaction (transactionHash: string): Promise<Transaction> {
    return this.web3.eth.getTransaction(transactionHash)
  }

  async getBlock (blockHashOrBlockNumber: BlockNumber): Promise<BlockTransactionString> {
    return this.web3.eth.getBlock(blockHashOrBlockNumber)
  }

  async getCode (address: string): Promise<string> {
    return this.web3.eth.getCode(address)
  }

  getChainId (): number {
    if (this.chainId == null) {
      console.log('ContractInteractorWeb3 :: getChainId : init not called')
      throw new Error('_init not called')
    }
    return this.chainId
  }

  getNetworkId (): number {
    if (this.networkId == null) {
      console.log('ContractInteractorWeb3 :: getNetworkId : init not called')
      throw new Error('_init not called')
    }
    return this.networkId
  }

  getNetworkType (): string {
    if (this.networkType == null) {
      console.log('ContractInteractorWeb3 :: getNetworkType : init not called')
      throw new Error('_init not called')
    }
    return this.networkType
  }
}

/**
 * Ganache does not seem to enforce EIP-155 signature. Buidler does, though.
 * This is how {@link Transaction} constructor allows support for custom and private network.
 * @param chainId
 * @param networkId
 * @param chain
 * @return {{common: Common}}
 */
export function getRawTxOptions (chainId: number, networkId: number, chain?: string): TransactionOptions {
  return {
    common: Common.forCustomChain(
      chain ?? 'mainnet',
      {
        chainId,
        networkId
      }, 'istanbul')
  }
}
