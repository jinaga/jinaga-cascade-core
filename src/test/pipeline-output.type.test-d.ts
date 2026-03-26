import { expectType } from 'tsd';
import {
    createPipeline,
    type KeyedArray,
    type PipelineOutput,
    type PipelinePlainOutput
} from '../index.js';

// groupBy leaves nested KeyedArray in the row shape; PipelinePlainOutput flattens to arrays
{
    const builder = createPipeline<{ category: string; lineId: string; qty: number }>()
        .groupBy(['category'], 'items');

    type Row = PipelineOutput<typeof builder>;
    type Plain = PipelinePlainOutput<typeof builder>;

    expectType<{ category: string; items: KeyedArray<{ lineId: string; qty: number }> }>({} as Row);
    expectType<{ category: string; items: { lineId: string; qty: number }[] }>({} as Plain);
}

// groupBy + sum: builder type keeps the array and adds the aggregate (PipelinePlainOutput matches)
{
    const builder = createPipeline<{ category: string; lineId: string; qty: number }>()
        .groupBy(['category'], 'items')
        .sum('items', 'qty', 'totalQty');

    type Row = PipelineOutput<typeof builder>;
    type Plain = PipelinePlainOutput<typeof builder>;

    expectType<{
        category: string;
        items: KeyedArray<{ lineId: string; qty: number }>;
        totalQty: number;
    }>({} as Row);
    expectType<{
        category: string;
        items: { lineId: string; qty: number }[];
        totalQty: number;
    }>({} as Plain);
}

// Nested groupBy: KeyedArray rows use { key, value }; PipelinePlainOutput uses plain arrays of T
{
    const builder = createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
        .groupBy(['state'], 'cities')
        .in('items')
        .groupBy(['city'], 'cities');

    type Row = PipelineOutput<typeof builder>;
    type Plain = PipelinePlainOutput<typeof builder>;

    expectType<string>({} as Row['state']);
    expectType<string>({} as Plain['state']);
    type RowInner = Row['items'][number]['value'];
    type PlainInner = Plain['items'][number];
    expectType<string>({} as RowInner['city']);
    expectType<string>({} as PlainInner['city']);
    expectType<KeyedArray<{ venue: string; capacity: number }>>({} as RowInner['items']);
    expectType<{ venue: string; capacity: number }[]>({} as PlainInner['items']);
}

// Ordinary arrays (not KeyedArray) stay arrays through PipelinePlainOutput, not mapped object types
{
    const builder = createPipeline<{ id: string }>()
        .defineProperty('tags', () => [] as string[], []);

    type Plain = PipelinePlainOutput<typeof builder>;
    expectType<readonly string[]>({} as Plain['tags']);
}
