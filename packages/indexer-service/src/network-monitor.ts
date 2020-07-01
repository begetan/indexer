import axios, { AxiosInstance } from 'axios'
import gql from 'graphql-tag'
import { Evt } from 'evt'
import { logging, subgraph as networkSubgraph } from '@graphprotocol/common-ts'
import { delay } from '@connext/utils'
import { Wallet } from 'ethers'
import { ChannelInfo } from './types'

export interface ChannelsUpdatedEvent {
  added: ChannelInfo[]
  removed: ChannelInfo[]
  unchanged: ChannelInfo[]
}

const channelInList = (channels: ChannelInfo[], needle: ChannelInfo): boolean =>
  channels.find(channel => channel.id === needle.id) !== undefined

export interface NetworkMonitorOptions {
  logger: logging.Logger
  wallet: Wallet
  graphNode: string
  networkSubgraphDeployment: string
}

export class NetworkMonitor {
  channelsUpdated: Evt<ChannelsUpdatedEvent>
  channels: ChannelInfo[]

  constructor(options: NetworkMonitorOptions) {
    this.channelsUpdated = Evt.create<ChannelsUpdatedEvent>()
    this.channels = []
    this.periodicallySyncChannels(options)
  }

  async periodicallySyncChannels({
    logger,
    wallet,
    networkSubgraphDeployment,
    graphNode,
  }: NetworkMonitorOptions) {
    let url = new URL(`/subgraphs/id/${networkSubgraphDeployment}`, graphNode)
    let client = await networkSubgraph.createNetworkSubgraphClient({
      url: url.toString(),
    })

    while (true) {
      try {
        // Query graph-node for indexing subgraph versions
        let result = await client
          .query(
            gql`
              query indexedSubgraphs($id: ID!) {
                indexer(id: $id) {
                  channels {
                    id
                    publicKey
                    subgraphDeployment {
                      id
                    }
                    createdAtEpoch
                  }
                }
              }
            `,
            { id: wallet.address.toLowerCase() },
          )
          .toPromise()

        if (!result.data || !result.data.indexer) {
          throw new Error(`Indexer '${wallet.address}' has not registered itself yet`)
        }

        // Extract the channels
        let channels: ChannelInfo[] = result.data.indexer.channels.map(
          ({ id, publicKey, subgraphDeployment, createdAtEpoch }: any) => ({
            id,
            publicKey,
            subgraphDeploymentID: subgraphDeployment.id,
            createdAtEpoch,
          }),
        )

        // Identify channel changes
        let removed = this.channels.filter(channel => !channelInList(channels, channel))
        let added = channels.filter(
          newChannel => !channelInList(this.channels, newChannel),
        )
        let unchanged = this.channels.filter(channel => channelInList(channels, channel))

        // Update channels
        this.channels = channels

        // Emit the update
        if (removed.length > 0 || added.length > 0) {
          this.channelsUpdated.post({ added, removed, unchanged })
        }
      } catch (e) {
        logger.warn(`Failed to query channels: ${e}`)
      }

      // Wait 5s
      await delay(5000)
    }
  }
}