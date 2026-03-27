import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

interface Order {
    orderId: string;
    customerId: string;
    total: number;
}

interface CustomerStatus {
    customerId: string;
    status: string;
}

describe('pipeline enrich', () => {
    it('uses undefined for the enriched property when whenMissing is omitted', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<Order, 'orders'>('orders')
                .enrich(
                    'customerStatuses',
                    createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
                        .groupBy(['customerId'], 'customerStatuses'),
                    ['customerId'],
                    'customerStatus'
                )
        );

        pipeline.add('order-1', { orderId: 'order-1', customerId: 'c-1', total: 125 });

        expect(getOutput()).toEqual([
            {
                orderId: 'order-1',
                customerId: 'c-1',
                total: 125,
                customerStatus: undefined
            }
        ]);
    });

    it('keeps primary rows and applies whenMissing until a secondary match appears', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<Order, 'orders'>('orders')
                .enrich(
                    'customerStatuses',
                    createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
                        .groupBy(['customerId'], 'customerStatuses'),
                    ['customerId'],
                    'customerStatus',
                    {
                        customerId: '',
                        customerStatuses: []
                    }
                )
        );

        pipeline.add('order-1', { orderId: 'order-1', customerId: 'c-1', total: 125 });

        expect(getOutput()).toEqual([
            {
                orderId: 'order-1',
                customerId: 'c-1',
                total: 125,
                customerStatus: {
                    customerId: '',
                    customerStatuses: []
                }
            }
        ]);

        const sources = (pipeline as unknown as {
            sources: {
                customerStatuses: {
                    add: (key: string, immutableProps: CustomerStatus) => void;
                };
            };
        }).sources;

        sources.customerStatuses.add('status-1', { customerId: 'c-1', status: 'gold' });

        expect(getOutput()).toEqual([
            {
                orderId: 'order-1',
                customerId: 'c-1',
                total: 125,
                customerStatus: {
                    customerId: 'c-1',
                    customerStatuses: [{ key: 'status-1', value: { status: 'gold' } }]
                }
            }
        ]);
    });

    it('updates only primary rows whose join key matches changed secondary rows', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<Order, 'orders'>('orders')
                .enrich(
                    'customerStatuses',
                    createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
                        .groupBy(['customerId'], 'customerStatuses'),
                    ['customerId'],
                    'customerStatus',
                    {
                        customerId: '',
                        customerStatuses: []
                    }
                )
        );

        pipeline.add('order-1', { orderId: 'order-1', customerId: 'c-1', total: 50 });
        pipeline.add('order-2', { orderId: 'order-2', customerId: 'c-2', total: 75 });

        const sources = (pipeline as unknown as {
            sources: {
                customerStatuses: {
                    add: (key: string, immutableProps: CustomerStatus) => void;
                };
            };
        }).sources;

        sources.customerStatuses.add('status-c1', { customerId: 'c-1', status: 'silver' });

        expect(getOutput()).toEqual([
            {
                orderId: 'order-1',
                customerId: 'c-1',
                total: 50,
                customerStatus: {
                    customerId: 'c-1',
                    customerStatuses: [{ key: 'status-c1', value: { status: 'silver' } }]
                }
            },
            {
                orderId: 'order-2',
                customerId: 'c-2',
                total: 75,
                customerStatus: {
                    customerId: '',
                    customerStatuses: []
                }
            }
        ]);
    });

    it('emits enrich_key_arity_mismatch and keeps whenMissing when key arity differs', () => {
        const diagnostics: string[] = [];
        let latestState: Array<{ key: string; value: {
            orderId: string;
            customerId: string;
            total: number;
            customerStatus: { customerId: string; customerStatuses: Array<{ key: string; value: { status: string } }> };
        } }> = [];

        const pipeline = createPipeline<Order, 'orders'>('orders')
            .enrich(
                'customerStatuses',
                createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
                    .groupBy(['customerId'], 'customerStatuses'),
                ['customerId', 'orderId'],
                'customerStatus',
                {
                    customerId: '',
                    customerStatuses: []
                }
            )
            .build(transform => {
                latestState = transform(latestState);
            }, {
                onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
            });

        pipeline.add('order-1', { orderId: 'order-1', customerId: 'c-1', total: 125 });
        pipeline.sources.customerStatuses.add('status-1', { customerId: 'c-1', status: 'gold' });
        pipeline.flush();

        expect(diagnostics).toContain('enrich_key_arity_mismatch');
        expect(latestState).toEqual([
            {
                key: 'order-1',
                value: {
                    orderId: 'order-1',
                    customerId: 'c-1',
                    total: 125,
                    customerStatus: {
                        customerId: '',
                        customerStatuses: []
                    }
                }
            }
        ]);
    });

    it('emits enrich_secondary_collection_key_missing when secondary has no collection key', () => {
        const diagnostics: string[] = [];

        const pipeline = createPipeline<Order, 'orders'>('orders')
            .enrich(
                'customerStatuses',
                createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses'),
                ['customerId'],
                'customerStatus',
                {
                    customerId: '',
                    status: ''
                }
            )
            .build(() => undefined, {
                onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
            });

        pipeline.add('order-1', { orderId: 'order-1', customerId: 'c-1', total: 125 });
        pipeline.sources.customerStatuses.add('status-1', { customerId: 'c-1', status: 'gold' });
        pipeline.flush();

        expect(diagnostics).toContain('enrich_secondary_collection_key_missing');
    });
});
