import { DescriptorNode, TypeDescriptor, ScalarDescriptor, getScalarsAtPath } from '../pipeline';

describe('DescriptorNode with scalars', () => {
    it('should allow empty scalars array', () => {
        const node: DescriptorNode = {
            arrays: [],
            collectionKey: [],
            scalars: [],
            objects: [],
            mutableProperties: []
        };
        expect(node.scalars).toEqual([]);
    });

    it('should store scalar descriptors', () => {
        const scalars: ScalarDescriptor[] = [
            { name: 'id', type: 'string' },
            { name: 'amount', type: 'number' }
        ];
        const node: DescriptorNode = {
            arrays: [],
            collectionKey: [],
            scalars,
            objects: [],
            mutableProperties: []
        };
        expect(node.scalars).toHaveLength(2);
        expect(node.scalars[0]).toEqual({ name: 'id', type: 'string' });
        expect(node.scalars[1]).toEqual({ name: 'amount', type: 'number' });
    });

    it('should work in TypeDescriptor', () => {
        const descriptor: TypeDescriptor = {
            rootCollectionName: 'orders',
            arrays: [],
            collectionKey: ['orderId'],
            scalars: [
                { name: 'orderId', type: 'string' },
                { name: 'total', type: 'number' }
            ],
            objects: [],
            mutableProperties: []
        };
        expect(descriptor.scalars).toHaveLength(2);
        expect(descriptor.rootCollectionName).toBe('orders');
    });

    it('should maintain existing fields alongside scalars', () => {
        const descriptor: TypeDescriptor = {
            rootCollectionName: 'items',
            arrays: [],
            collectionKey: ['id'],
            scalars: [{ name: 'id', type: 'string' }],
            mutableProperties: ['status'],
            objects: []
        };
        expect(descriptor.mutableProperties).toEqual(['status']);
        expect(descriptor.scalars).toHaveLength(1);
    });
});

describe('getScalarsAtPath utility', () => {
    it('should return root scalars for empty path', () => {
        const descriptor: TypeDescriptor = {
            rootCollectionName: 'orders',
            arrays: [],
            collectionKey: [],
            scalars: [
                { name: 'orderId', type: 'string' },
                { name: 'total', type: 'number' }
            ],
            objects: [],
            mutableProperties: []
        };
        const scalars = getScalarsAtPath(descriptor, []);
        expect(scalars).toHaveLength(2);
        expect(scalars[0].name).toBe('orderId');
    });

    it('should return scalars from nested array', () => {
        const descriptor: TypeDescriptor = {
            rootCollectionName: 'orders',
            arrays: [{
                name: 'items',
                type: {
                    arrays: [],
                    collectionKey: ['itemId'],
                    scalars: [
                        { name: 'itemId', type: 'string' },
                        { name: 'price', type: 'number' }
                    ],
                    objects: [],
                    mutableProperties: []
                }
            }],
            collectionKey: [],
            scalars: [],
            objects: [],
            mutableProperties: []
        };
        const scalars = getScalarsAtPath(descriptor, ['items']);
        expect(scalars).toHaveLength(2);
        expect(scalars.find(s => s.name === 'price')?.type).toBe('number');
    });

    it('should return empty array for invalid path', () => {
        const descriptor: TypeDescriptor = {
            rootCollectionName: 'orders',
            arrays: [],
            collectionKey: [],
            scalars: [{ name: 'id', type: 'string' }],
            objects: [],
            mutableProperties: []
        };
        const scalars = getScalarsAtPath(descriptor, ['nonexistent']);
        expect(scalars).toEqual([]);
    });

    it('should traverse deeply nested paths', () => {
        const descriptor: TypeDescriptor = {
            rootCollectionName: 'root',
            arrays: [{
                name: 'level1',
                type: {
                    arrays: [{
                        name: 'level2',
                        type: {
                            arrays: [],
                            collectionKey: [],
                            scalars: [{ name: 'deep', type: 'boolean' }],
                            objects: [],
                            mutableProperties: []
                        }
                    }],
                    collectionKey: [],
                    scalars: [],
                    objects: [],
                    mutableProperties: []
                }
            }],
            collectionKey: [],
            scalars: [],
            objects: [],
            mutableProperties: []
        };
        const scalars = getScalarsAtPath(descriptor, ['level1', 'level2']);
        expect(scalars).toHaveLength(1);
        expect(scalars[0].name).toBe('deep');
    });
});
