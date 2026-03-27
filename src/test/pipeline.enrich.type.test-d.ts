import { expectError, expectType } from 'tsd';
import { createPipeline, type KeyedArray, type PipelineOutput } from '../index.js';

interface Order {
    orderId: string;
    customerId: string;
    regionId: string;
    total: number;
}

interface CustomerStatus {
    customerId: string;
    status: string;
}

interface RegionStatus {
    regionId: string;
    label: string;
}

function noopSetState(): never {
    throw new Error('not implemented');
}

{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    const ordersPipeline = createPipeline<Order, 'orders'>('orders')
        .enrich(
            'customerStatuses',
            customerStatusPipeline,
            ['customerId'],
            'customerStatus',
            {
                customerId: '',
                customerStatuses: []
            }
        );

    type Row = PipelineOutput<typeof ordersPipeline>;
    expectType<{
        orderId: string;
        customerId: string;
        regionId: string;
        total: number;
        customerStatus: PipelineOutput<typeof customerStatusPipeline>;
    }>({} as Row);
}

{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    expectError(
        createPipeline<Order, 'orders'>('orders').enrich(
            'customerStatuses',
            customerStatusPipeline,
            ['customerId'],
            'customerStatus',
            {
                customerId: ''
            }
        )
    );
}

{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    expectError(
        createPipeline<Order, 'orders'>('orders').enrich(
            'customerStatuses',
            customerStatusPipeline,
            ['doesNotExist'],
            'customerStatus'
        )
    );
}

{
    type NestedSecondaryInput = { rows: KeyedArray<CustomerStatus> };
    const nestedSecondary = createPipeline<NestedSecondaryInput, 'root'>('root').in('rows');

    expectError(
        createPipeline<Order, 'orders'>('orders').enrich(
            'customerStatuses',
            nestedSecondary,
            ['customerId'],
            'customerStatus'
        )
    );
}

{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');
    const regionPipeline = createPipeline<RegionStatus, 'regions'>('regions')
        .groupBy(['regionId'], 'regions');

    const built = createPipeline<Order, 'orders'>('orders')
        .enrich('customerStatuses', customerStatusPipeline, ['customerId'], 'customerStatus')
        .enrich('regions', regionPipeline, ['regionId'], 'regionStatus')
        .build(noopSetState);

    expectType<(key: string, immutableProps: CustomerStatus) => void>(built.sources.customerStatuses.add);
    expectType<(key: string, immutableProps: RegionStatus) => void>(built.sources.regions.add);
    type SourceNames = keyof typeof built.sources;
    expectType<'customerStatuses' | 'regions'>({} as SourceNames);
}

{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    const noDefaultOrders = createPipeline<Order, 'orders'>('orders').enrich(
        'customerStatuses',
        customerStatusPipeline,
        ['customerId'],
        'customerStatus'
    );
    type RowWithoutDefault = PipelineOutput<typeof noDefaultOrders>;
    expectType<{
        orderId: string;
        customerId: string;
        regionId: string;
        total: number;
        customerStatus: PipelineOutput<typeof customerStatusPipeline> | undefined;
    }>({} as RowWithoutDefault);
}

{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    const withDefaultOrders = createPipeline<Order, 'orders'>('orders').enrich(
        'customerStatuses',
        customerStatusPipeline,
        ['customerId'],
        'customerStatus',
        { customerId: '', customerStatuses: [] }
    );
    type RowWithDefault = PipelineOutput<typeof withDefaultOrders>;
    expectType<{
        orderId: string;
        customerId: string;
        regionId: string;
        total: number;
        customerStatus: PipelineOutput<typeof customerStatusPipeline>;
    }>({} as RowWithDefault);
}
