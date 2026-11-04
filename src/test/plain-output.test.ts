import { createPipeline, toPipelinePlainOutput, type KeyedArray } from '../index.js';
import { createTestPipeline } from './helpers.js';

describe('toPipelinePlainOutput', () => {
    it('converts root keyed rows to plain objects', () => {
        const builder = createPipeline<{ id: string; n: number }>();
        const descriptor = builder.getTypeDescriptor();
        const state = [{ key: 'a', value: { id: 'a', n: 1 } }];
        expect(toPipelinePlainOutput(state, descriptor)).toEqual([{ id: 'a', n: 1 }]);
    });

    it('converts nested KeyedArray properties using descriptor arrays', () => {
        const builder = createPipeline<{ category: string; sku: string; qty: number }>()
            .groupBy(['category'], 'items');
        const descriptor = builder.getTypeDescriptor();
        const state = [
            {
                key: 'c1',
                value: {
                    category: 'A',
                    items: [
                        { key: 'l1', value: { sku: 's1', qty: 2 } },
                        { key: 'l2', value: { sku: 's2', qty: 3 } }
                    ]
                }
            }
        ];
        expect(toPipelinePlainOutput(state, descriptor)).toEqual([
            {
                category: 'A',
                items: [
                    { sku: 's1', qty: 2 },
                    { sku: 's2', qty: 3 }
                ]
            }
        ]);
    });

    it('converts keyed arrays inside an object property', () => {
        const secondary = createPipeline<{ sku: string; price: number }, 'prices'>('prices', [
            { name: 'sku', type: 'string' },
            { name: 'price', type: 'number' }
        ]).groupBy(['sku'], 'skus');
        const builder = createPipeline<{ sku: string; qty: number }, 'orders'>('orders', [
            { name: 'sku', type: 'string' },
            { name: 'qty', type: 'number' }
        ]).enrich('catalog', secondary, ['sku'], 'product');
        const descriptor = builder.getTypeDescriptor();
        const state = [
            {
                key: 'o1',
                value: {
                    sku: 'a',
                    qty: 2,
                    product: { sku: 'a', prices: [{ key: 'p2', value: { price: 7 } }] }
                }
            }
        ];
        expect(toPipelinePlainOutput(state, descriptor)).toEqual([
            { sku: 'a', qty: 2, product: { sku: 'a', prices: [{ price: 7 }] } }
        ]);
    });

    it('leaves an object without its arrays as it is', () => {
        type Item = { price: number; parts: KeyedArray<{ name: string }> };
        const builder = createPipeline<{ category: string }, 'categories', { items: KeyedArray<Item> }>('categories', [
            { name: 'category', type: 'string' }
        ], [{
            name: 'items',
            type: {
                scalars: [{ name: 'price', type: 'number' }],
                arrays: [{ name: 'parts', type: { scalars: [], arrays: [], collectionKey: [], objects: [] } }],
                collectionKey: [],
                objects: []
            }
        }]).pickByMin('items', 'price', 'cheapest');
        const descriptor = builder.getTypeDescriptor();
        const state = [{ key: 'c1', value: { category: 'A', cheapest: { price: 3 } } }];
        expect(toPipelinePlainOutput(state, descriptor)).toEqual([
            { category: 'A', items: [], cheapest: { price: 3 } }
        ]);
    });

    it('makes plain the arrays of an enriched row', () => {
        const secondary = createPipeline<{ sku: string; price: number }, 'prices'>('prices', [
            { name: 'sku', type: 'string' },
            { name: 'price', type: 'number' }
        ]).groupBy(['sku'], 'skus');
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ sku: string; qty: number }, 'orders'>('orders', [
                { name: 'sku', type: 'string' },
                { name: 'qty', type: 'number' }
            ]).enrich('catalog', secondary, ['sku'], 'product'));
        pipeline.add('o1', { sku: 'a', qty: 2 });
        pipeline.sources.catalog.add('p1', { sku: 'a', price: 5 });
        pipeline.sources.catalog.add('p2', { sku: 'a', price: 7 });
        pipeline.sources.catalog.remove('p1', { sku: 'a', price: 5 });
        const output = getOutput();
        expect(output).toEqual([
            { sku: 'a', qty: 2, product: { sku: 'a', prices: [{ price: 7 }] } }
        ]);
        expect(output[0].product?.prices[0].price).toBe(7);
    });
});
