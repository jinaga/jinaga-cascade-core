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

interface LoyaltyStatus {
    customerId: string;
    tier: string;
}

function noopSetState(): never {
    throw new Error('not implemented');
}

// Basic enrich typing: output row keeps primary shape and adds full secondary output object.
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
    type CustomerStatusOutput = PipelineOutput<typeof customerStatusPipeline>;

    expectType<CustomerStatusOutput>({} as Row['customerStatus']);
    expectType<{
        orderId: string;
        customerId: string;
        regionId: string;
        total: number;
        customerStatus: PipelineOutput<typeof customerStatusPipeline>;
    }>({} as Row);
}

// whenMissing must match full secondary output shape.
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

// primaryKey members must exist on the current scope.
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

// Secondary pipeline must be root-scoped (Path = []).
{
    type NestedSecondaryInput = {
        rows: KeyedArray<CustomerStatus>;
    };
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

// Scoped enrich uses key properties from the scoped item type, not the root type.
{
    type OrdersByRegion = {
        regionId: string;
        orders: KeyedArray<Order>;
    };

    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    const scopedBuilder = createPipeline<OrdersByRegion, 'byRegion'>('byRegion')
        .in('orders')
        .enrich('customerStatuses', customerStatusPipeline, ['customerId'], 'customerStatus');

    type Row = PipelineOutput<typeof scopedBuilder>;
    type NestedOrder = Row['orders'][number]['value'];
    type CustomerStatusOutput = PipelineOutput<typeof customerStatusPipeline>;
    expectType<CustomerStatusOutput | undefined>({} as NestedOrder['customerStatus']);

    expectError(
        createPipeline<OrdersByRegion, 'byRegion'>('byRegion')
            .in('orders')
            .enrich('customerStatuses', customerStatusPipeline, ['foo'], 'customerStatus')
    );
}

// build() sources typing includes sourceName mapped to secondary input type.
{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');

    const pipeline = createPipeline<Order, 'orders'>('orders')
        .enrich('customerStatuses', customerStatusPipeline, ['customerId'], 'customerStatus')
        .build(noopSetState);

    expectType<(key: string, immutableProps: CustomerStatus) => void>(pipeline.sources.customerStatuses.add);
    expectType<(key: string, immutableProps: CustomerStatus) => void>(pipeline.sources.customerStatuses.remove);
}

// Recursive source typing: if secondary pipeline uses enrich, nested sources are exposed.
{
    const loyaltyPipeline = createPipeline<LoyaltyStatus, 'loyalty'>('loyalty')
        .groupBy(['customerId'], 'loyaltyRows');

    const customerStatusWithLoyalty = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses')
        .enrich(
            'loyalty',
            loyaltyPipeline,
            ['customerId'],
            'loyaltySnapshot',
            {
                customerId: '',
                loyalty: []
            }
        );

    const ordersPipeline = createPipeline<Order, 'orders'>('orders')
        .enrich('customerStatuses', customerStatusWithLoyalty, ['customerId'], 'customerStatus');

    type Row = PipelineOutput<typeof ordersPipeline>;
    type CustomerStatusOutput = PipelineOutput<typeof customerStatusWithLoyalty>;
    type LoyaltyOutput = PipelineOutput<typeof loyaltyPipeline>;
    expectType<CustomerStatusOutput | undefined>({} as Row['customerStatus']);
    expectType<LoyaltyOutput>({} as NonNullable<Row['customerStatus']>['loyaltySnapshot']);

    const pipeline = ordersPipeline.build(noopSetState);
    expectType<(key: string, immutableProps: CustomerStatus) => void>(pipeline.sources.customerStatuses.add);
    expectType<(key: string, immutableProps: LoyaltyStatus) => void>(
        pipeline.sources.customerStatuses.sources.loyalty.add
    );
}

// Multiple enrich calls accumulate distinct sources and enrichment properties.
{
    const customerStatusPipeline = createPipeline<CustomerStatus, 'customerStatuses'>('customerStatuses')
        .groupBy(['customerId'], 'customerStatuses');
    const regionPipeline = createPipeline<RegionStatus, 'regions'>('regions')
        .groupBy(['regionId'], 'regions');

    const builder = createPipeline<Order, 'orders'>('orders')
        .enrich('customerStatuses', customerStatusPipeline, ['customerId'], 'customerStatus')
        .enrich('regions', regionPipeline, ['regionId'], 'regionStatus');

    type Row = PipelineOutput<typeof builder>;
    expectType<PipelineOutput<typeof customerStatusPipeline> | undefined>({} as Row['customerStatus']);
    expectType<PipelineOutput<typeof regionPipeline> | undefined>({} as Row['regionStatus']);

    const pipeline = builder.build(noopSetState);
    expectType<(key: string, immutableProps: CustomerStatus) => void>(pipeline.sources.customerStatuses.add);
    expectType<(key: string, immutableProps: RegionStatus) => void>(pipeline.sources.regions.add);
    type SourceNames = keyof typeof pipeline.sources;
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
