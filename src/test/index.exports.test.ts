import { ScalarType, ScalarDescriptor } from '../index';

describe('Public API exports', () => {
    it('should export ScalarType', () => {
        const type: ScalarType = 'string';
        expect(type).toBe('string');
    });

    it('should export ScalarDescriptor', () => {
        const desc: ScalarDescriptor = { name: 'id', type: 'number' };
        expect(desc.name).toBe('id');
        expect(desc.type).toBe('number');
    });
});
