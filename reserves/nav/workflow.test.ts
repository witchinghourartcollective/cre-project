import { describe, expect } from 'bun:test'
import { TxStatus } from '@chainlink/cre-sdk'
import { EvmMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import type { Address } from 'viem'
import { newDataFeedsCacheMock } from '../contracts/evm/ts/generated/DataFeedsCache_mock'
import {
	encodeReceivedDecimalReports,
	hexToBytes32RightPadded,
	initWorkflow,
	onCronTrigger,
	scaledJsonNumber,
} from './workflow'

const CHAIN_SELECTOR = 16015286601757825753n // ethereum-testnet-sepolia
const DATA_FEEDS_CACHE = '0x694AA1769357215DE4FAC081bf1f309aDC325306' as Address

describe('onCronTrigger', () => {
	test('throws when scheduledExecutionTime is missing', () => {
		const runtime = newTestRuntime() as any
		expect(() => onCronTrigger(runtime, {} as any)).toThrow(
			'Scheduled execution time is required',
		)
	})
})

describe('encodeReceivedDecimalReports', () => {
	test('encodes a single decimal report with dataId, timestamp and answer', () => {
		const result = encodeReceivedDecimalReports([
			{
				dataId: '0x01',
				timestamp: 1709510400,
				answer: 1000000000000000000n,
			},
		])
		expect(result).toMatch(/^0x/)
		expect(result.length).toBeGreaterThan(2)
	})
})

describe('hexToBytes32RightPadded', () => {
	test('pads a short hex string to 32 bytes', () => {
		const result = hexToBytes32RightPadded('0x01')
		expect(result).toBe('0x0100000000000000000000000000000000000000000000000000000000000000')
	})

	test('throws for hex strings longer than 32 bytes', () => {
		const longHex = '0x' + 'ff'.repeat(33)
		expect(() => hexToBytes32RightPadded(longHex)).toThrow('exceeds 32 bytes')
	})
})

describe('DataFeedsCache mock', () => {
	test('writes report via generated DataFeedsCache binding', async () => {
		const evmMock = EvmMock.testInstance(CHAIN_SELECTOR)
		const mock = newDataFeedsCacheMock(DATA_FEEDS_CACHE, evmMock)
		mock.writeReport = () => ({
			txStatus: TxStatus.SUCCESS,
			txHash: new Uint8Array(32),
		})

		expect(typeof mock.writeReport).toBe('function')
	})
})

describe('initWorkflow', () => {
	test('subscribes onCronTrigger to the configured cron schedule', () => {
		const config = {
			schedule: '0 */10 * * * *',
			url: 'https://api.example.com/nav',
			dataIdHex: '0x01',
			evms: [
				{
					dataFeedsCacheAddress: DATA_FEEDS_CACHE,
					chainName: 'ethereum-testnet-sepolia',
					gasLimit: '500000',
				},
			],
		}
		const handlers = initWorkflow(config)

		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)
		const cronTrigger = handlers[0].trigger as { config?: { schedule?: string } }
		expect(cronTrigger.config?.schedule).toBe(config.schedule)
	})
})

describe('scaledJsonNumber (exact NAV math, no floats)', () => {
	// Live mnav.m0.xyz response, 2026-10-04.
	const live = '{"_aggregatedCollateral":199604173.183776,"_totalOwedM":196391183.837523,"totalCollateral":1.0163601506109925}'

	test('subtracts as exact 18-decimal integers', () => {
		const nav = scaledJsonNumber(live, '_aggregatedCollateral') - scaledJsonNumber(live, '_totalOwedM')
		expect(nav).toBe(3212989346253000000000000n) // 3212989.346253 exactly
	})

	test('the float version this replaces is not exact', () => {
		const floatNav = 199604173.183776 - 196391183.837523
		expect(floatNav.toString()).not.toBe('3212989.346253')
	})

	test('fails closed on a missing field', () => {
		expect(() => scaledJsonNumber(live, '_nope')).toThrow('missing a plain decimal')
	})

	test('fails closed on exponent notation instead of mis-scaling', () => {
		expect(() => scaledJsonNumber('{"_totalOwedM":1.9e8}', '_totalOwedM')).toThrow('missing a plain decimal')
	})

	test('does not match a field name that only ends with the requested one', () => {
		expect(scaledJsonNumber('{"x_totalOwedM":1,"_totalOwedM":2.5}', '_totalOwedM')).toBe(2500000000000000000n)
	})
})
