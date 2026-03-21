import { ScalarType, ScalarDescriptor } from '../pipeline';

describe('ScalarType and ScalarDescriptor', () => {
    it('should define string scalar type', () => {
        const scalarType: ScalarType = 'string';
        expect(scalarType).toBe('string');
    });

    it('should define number scalar type', () => {
        const scalarType: ScalarType = 'number';
        expect(scalarType).toBe('number');
    });

    it('should define boolean scalar type', () => {
        const scalarType: ScalarType = 'boolean';
        expect(scalarType).toBe('boolean');
    });

    it('should define date scalar type', () => {
        const scalarType: ScalarType = 'date';
        expect(scalarType).toBe('date');
    });

    it('should define unknown scalar type', () => {
        const scalarType: ScalarType = 'unknown';
        expect(scalarType).toBe('unknown');
    });

    it('should create a ScalarDescriptor with name and type', () => {
        const descriptor: ScalarDescriptor = {
            name: 'id',
            type: 'string'
        };
        expect(descriptor.name).toBe('id');
        expect(descriptor.type).toBe('string');
    });

    it('should create ScalarDescriptor for numeric field', () => {
        const descriptor: ScalarDescriptor = {
            name: 'amount',
            type: 'number'
        };
        expect(descriptor.name).toBe('amount');
        expect(descriptor.type).toBe('number');
    });
});
