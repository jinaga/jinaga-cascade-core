import { createPipeline } from '../factory';

interface Product {
    productId: string;
    name: string;
    price: number;
    inStock: boolean;
}

describe('createPipeline with typed source', () => {
    it('should accept source scalar descriptors', () => {
        const pipeline = createPipeline<Product, 'products'>('products', [
            { name: 'productId', type: 'string' },
            { name: 'name', type: 'string' },
            { name: 'price', type: 'number' },
            { name: 'inStock', type: 'boolean' }
        ]);
        
        const descriptor = pipeline.getTypeDescriptor();
        expect(descriptor.scalars).toHaveLength(4);
        expect(descriptor.scalars.find(s => s.name === 'price')?.type).toBe('number');
        expect(descriptor.scalars.find(s => s.name === 'inStock')?.type).toBe('boolean');
    });

    it('should create empty scalars when no source type provided', () => {
        const pipeline = createPipeline<Product, 'products'>('products');
        
        const descriptor = pipeline.getTypeDescriptor();
        expect(descriptor.scalars).toEqual([]);
    });

    it('should preserve scalars through pipeline builder', () => {
        const pipeline = createPipeline<Product, 'products'>('products', [
            { name: 'id', type: 'string' },
            { name: 'amount', type: 'number' }
        ]);
        
        const descriptor = pipeline.getTypeDescriptor();
        expect(descriptor.scalars).toHaveLength(2);
        expect(descriptor.rootCollectionName).toBe('products');
    });
});
