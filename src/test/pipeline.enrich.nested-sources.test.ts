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

interface LoyaltyTier {
    customerId: string;
    tier: string;
}

function buildPipelineWithNestedSecondarySource() {
    return createPipeline<Order, 'orders'>('orders')
        .enrich(
            'customerStatuses',
            createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
                .groupBy(['customerId'], 'customerStatuses')
                .enrich(
                    'loyalty',
                    createPipeline<LoyaltyTier, 'loyalty'>('loyalty').groupBy(['customerId'], 'tiers'),
                    ['customerId'],
                    'loyaltySnapshot',
                    {
                        customerId: '',
                        loyalty: []
                    }
                ),
            ['customerId'],
            'customerStatus',
            {
                customerId: '',
                customerStatuses: [],
                loyaltySnapshot: {
                    customerId: '',
                    loyalty: []
                }
            }
        );
}

describe('pipeline enrich nested sources', () => {
    it('keeps nested secondary sources under their source input and does not flatten them', () => {
        const [pipeline, getOutput] = createTestPipeline(() => buildPipelineWithNestedSecondarySource());

        pipeline.add('order-1', { orderId: 'order-1', customerId: 'c-1', total: 125 });

        const sources = (pipeline as unknown as {
            sources: {
                customerStatuses: {
                    add: (key: string, immutableProps: CustomerStatus) => void;
                    sources: {
                        loyalty: {
                            add: (key: string, immutableProps: LoyaltyTier) => void;
                        };
                    };
                };
                loyalty?: unknown;
            };
        }).sources;

        expect(sources.loyalty).toBeUndefined();
        expect(typeof sources.customerStatuses.sources.loyalty.add).toBe('function');

        sources.customerStatuses.add('status-1', { customerId: 'c-1', status: 'gold' });

        expect(getOutput()[0].customerStatus.loyaltySnapshot).toEqual({
            customerId: '',
            loyalty: []
        });

        sources.customerStatuses.sources.loyalty.add('tier-1', { customerId: 'c-1', tier: 'platinum' });

        expect(getOutput()[0].customerStatus.loyaltySnapshot).toEqual({
            customerId: 'c-1',
            loyalty: [{ key: 'tier-1', value: { tier: 'platinum' } }]
        });
    });

    it('joins nested secondary source rows when nested source arrives before the outer source row', () => {
        const [pipeline, getOutput] = createTestPipeline(() => buildPipelineWithNestedSecondarySource());

        const sources = (pipeline as unknown as {
            sources: {
                customerStatuses: {
                    add: (key: string, immutableProps: CustomerStatus) => void;
                    sources: {
                        loyalty: {
                            add: (key: string, immutableProps: LoyaltyTier) => void;
                        };
                    };
                };
            };
        }).sources;

        sources.customerStatuses.sources.loyalty.add('tier-early', { customerId: 'c-2', tier: 'gold' });
        pipeline.add('order-2', { orderId: 'order-2', customerId: 'c-2', total: 80 });

        expect(getOutput()[0].customerStatus).toEqual({
            customerId: '',
            customerStatuses: [],
            loyaltySnapshot: {
                customerId: '',
                loyalty: []
            }
        });

        sources.customerStatuses.add('status-2', { customerId: 'c-2', status: 'active' });

        expect(getOutput()[0].customerStatus.loyaltySnapshot).toEqual({
            customerId: 'c-2',
            loyalty: [{ key: 'tier-early', value: { tier: 'gold' } }]
        });
    });
});
