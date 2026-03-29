import { createPipeline, toPipelinePlainOutput, type KeyedArray, type Transform } from '../index';
import { createTestPipeline, simulateState } from './helpers';
import type { PipelineBuilder, PipelineOutput } from '../builder';

/**
 * Targeted experiments for enrich join behavior, defineProperty deps, and ordering.
 * Each test encodes a falsifiable hypothesis documented in the suite name.
 */

describe('enrich experiments (hypothesis checks)', () => {
    interface Order {
        orderId: string;
        customerId: string;
        total: number;
    }

    interface CustomerStatus {
        customerId: string;
        status: string;
    }

    const whenMissingOrder = {
        customerId: '',
        customerStatuses: [] as { key: string; value: { status: string } }[]
    };

    /** A — Missing primary join field: row is not indexed; secondary never updates that row; diagnostic fires. */
    it('A: primary row missing join property emits diagnostic and cannot react when secondary arrives', () => {
        const diagnostics: string[] = [];
        type B = PipelineBuilder<
            Order & { customerStatus: typeof whenMissingOrder },
            Order,
            [],
            'orders',
            { customerStatuses: { primary: CustomerStatus; sources: Record<never, never> } }
        >;
        const builder = createPipeline<Order, 'orders'>('orders')
            .enrich(
                'customerStatuses',
                createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses').groupBy(
                    ['customerId'],
                    'customerStatuses'
                ),
                ['customerId'],
                'customerStatus',
                whenMissingOrder
            ) as unknown as B;

        type Row = PipelineOutput<B>;
        const [getState, setState] = simulateState<KeyedArray<Row>>([]);
        const typeDescriptor = builder.getTypeDescriptor();
        const pipeline = builder.build(setState as (t: Transform<KeyedArray<Row>>) => void, {
            onDiagnostic: d => {
                diagnostics.push(d.code);
            }
        });

        pipeline.add('order-bad', {
            orderId: 'order-bad',
            total: 99
        } as Order);

        expect(diagnostics).toContain('enrich_invalid_primary_key_property');

        pipeline.sources.customerStatuses.add('s1', { customerId: 'c-missing', status: 'gold' });

        pipeline.flush();
        const rows = toPipelinePlainOutput(getState(), typeDescriptor);
        expect(rows).toEqual([
            {
                orderId: 'order-bad',
                total: 99,
                customerStatus: whenMissingOrder
            }
        ]);
    });

    interface AllocationRow {
        attendeePublicKey: string;
        attendeeEventId: string;
        createdAt: string;
        votes: number;
    }

    interface ClassRow {
        attendeeEventId: string;
        investorFlag: number;
    }

    const whenMissingClass = {
        attendeeEventId: '',
        attendeeClasses: [] as { key: string; value: { investorFlag: number } }[]
    };

    function buildPickEnrichPipeline() {
        return createPipeline<AllocationRow, 'allocations'>('allocations')
            .groupBy(['attendeePublicKey', 'attendeeEventId'], 'attendees')
            .pickByMax('allocations', 'createdAt', 'latestAllocation')
            .enrich(
                'attendeeClasses',
                createPipeline<ClassRow, 'attendeeClasses'>('attendeeClasses').groupBy(
                    ['attendeeEventId'],
                    'attendeeClasses'
                ),
                ['attendeeEventId'],
                'classInfo',
                whenMissingClass
            );
    }

    /** B — JSON tuple hash: number vs string for the same logical id yields no join match. */
    it('B: primary join value number vs secondary string breaks hash equality (no enrichment match)', () => {
        const [pipeline, getOutput] = createTestPipeline(() => buildPickEnrichPipeline());

        pipeline.add('alloc-1', {
            attendeePublicKey: 'pk-a',
            attendeeEventId: 1 as unknown as string,
            createdAt: '2026-01-01T00:00:00.000Z',
            votes: 1
        });

        const sources = (pipeline as unknown as {
            sources: { attendeeClasses: { add: (key: string, immutableProps: ClassRow) => void } };
        }).sources;

        sources.attendeeClasses.add('class-1', { attendeeEventId: '1', investorFlag: 1 });

        const row = getOutput()[0];
        expect(row.classInfo.attendeeEventId).toBe('');
        expect(row.classInfo.attendeeClasses).toEqual([]);
    });

    /** C — defineProperty must list enrich output in mutableProperties or compute stays stale. */
    it('C: defineProperty without classInfo in mutableProperties does not recompute after enrich updates', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            buildPickEnrichPipeline().defineProperty(
                'effectiveBucket',
                row =>
                    row.classInfo.attendeeClasses?.[0]?.value.investorFlag === 1
                        ? 'investor'
                        : 'general',
                []
            )
        );

        pipeline.add('alloc-1', {
            attendeePublicKey: 'pk-a',
            attendeeEventId: 'ev-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            votes: 1
        });

        const sources = (pipeline as unknown as {
            sources: { attendeeClasses: { add: (key: string, immutableProps: ClassRow) => void } };
        }).sources;

        sources.attendeeClasses.add('class-ev-1', { attendeeEventId: 'ev-1', investorFlag: 1 });

        expect(getOutput()[0].effectiveBucket).toBe('general');
    });

    /** D — Secondary populated before primary still joins on first emission. */
    it('D: secondary add before primary add yields matched classInfo on first read', () => {
        const [pipeline, getOutput] = createTestPipeline(() => buildPickEnrichPipeline());

        const sources = (pipeline as unknown as {
            sources: { attendeeClasses: { add: (key: string, immutableProps: ClassRow) => void } };
        }).sources;

        sources.attendeeClasses.add('class-ev-1', { attendeeEventId: 'ev-1', investorFlag: 1 });

        pipeline.add('alloc-1', {
            attendeePublicKey: 'pk-a',
            attendeeEventId: 'ev-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            votes: 1
        });

        expect(getOutput()[0].classInfo).toEqual({
            attendeeEventId: 'ev-1',
            attendeeClasses: [{ key: 'class-ev-1', value: { investorFlag: 1 } }]
        });
    });
});
