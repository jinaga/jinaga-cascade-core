import { createPipeline, toPipelinePlainOutput } from '../index.js';

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
});
