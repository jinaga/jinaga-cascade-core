import { expectType, expectAssignable } from 'tsd';
import { KeyedArray } from '../builder';
import { NavigateToPath, ValidatePath, TransformAtPath } from '../types/path';

// Test data types
type SimpleInput = {
    state: string;
    name: string;
};

type InputWithOneLevel = {
    state: string;
    cities: KeyedArray<{
        city: string;
        population: number;
    }>;
};

type InputWithTwoLevels = {
    state: string;
    cities: KeyedArray<{
        city: string;
        venues: KeyedArray<{
            name: string;
            capacity: number;
        }>;
    }>;
};

type InputWithThreeLevels = {
    region: string;
    states: KeyedArray<{
        state: string;
        cities: KeyedArray<{
            city: string;
            venues: KeyedArray<{
                name: string;
            }>;
        }>;
    }>;
};

// ============================================
// NavigateToPath Tests
// ============================================

describe('NavigateToPath', () => {
    it('should return the original type for empty path', () => {
        type Result = NavigateToPath<SimpleInput, []>;
        expectType<SimpleInput>({} as Result);
    });

    it('should navigate to first level array item type', () => {
        type Result = NavigateToPath<InputWithOneLevel, ['cities']>;
        type Expected = {
            city: string;
            population: number;
        };
        expectType<Expected>({} as Result);
    });

    it('should navigate to second level array item type', () => {
        type Result = NavigateToPath<InputWithTwoLevels, ['cities', 'venues']>;
        type Expected = {
            name: string;
            capacity: number;
        };
        expectType<Expected>({} as Result);
    });

    it('should navigate to third level array item type', () => {
        type Result = NavigateToPath<InputWithThreeLevels, ['states', 'cities', 'venues']>;
        type Expected = {
            name: string;
        };
        expectType<Expected>({} as Result);
    });

    it('should return never for invalid property', () => {
        type Result = NavigateToPath<InputWithOneLevel, ['invalid']>;
        expectType<never>({} as Result);
    });

    it('should return never for non-array property', () => {
        type Result = NavigateToPath<InputWithOneLevel, ['state']>;
        expectType<never>({} as Result);
    });

    it('should return never for invalid nested path', () => {
        type Result = NavigateToPath<InputWithTwoLevels, ['cities', 'invalid']>;
        expectType<never>({} as Result);
    });
});

// ============================================
// ValidatePath Tests
// ============================================

describe('ValidatePath', () => {
    it('should return empty tuple for empty path', () => {
        type Result = ValidatePath<SimpleInput, []>;
        expectType<[]>({} as Result);
    });

    it('should return the path for valid single-level path', () => {
        type Result = ValidatePath<InputWithOneLevel, ['cities']>;
        expectType<['cities']>({} as Result);
    });

    it('should return the path for valid two-level path', () => {
        type Result = ValidatePath<InputWithTwoLevels, ['cities', 'venues']>;
        expectType<['cities', 'venues']>({} as Result);
    });

    it('should return the path for valid three-level path', () => {
        type Result = ValidatePath<InputWithThreeLevels, ['states', 'cities', 'venues']>;
        expectType<['states', 'cities', 'venues']>({} as Result);
    });

    it('should return never for invalid property', () => {
        type Result = ValidatePath<InputWithOneLevel, ['invalid']>;
        expectType<never>({} as Result);
    });

    it('should return never for non-array property', () => {
        type Result = ValidatePath<InputWithOneLevel, ['state']>;
        expectType<never>({} as Result);
    });

    it('should return never for invalid nested path', () => {
        type Result = ValidatePath<InputWithTwoLevels, ['cities', 'invalid']>;
        expectType<never>({} as Result);
    });

    it('should return never for path beyond valid depth', () => {
        type Result = ValidatePath<InputWithTwoLevels, ['cities', 'venues', 'extra']>;
        expectType<never>({} as Result);
    });
});

// ============================================
// TransformAtPath Tests
// ============================================

describe('TransformAtPath', () => {
    it('should return new type for empty path', () => {
        type NewType = { completely: 'new' };
        type Result = TransformAtPath<SimpleInput, [], NewType>;
        expectType<NewType>({} as Result);
    });

    it('should transform first level array item type', () => {
        type NewItemType = { transformed: boolean };
        type Result = TransformAtPath<InputWithOneLevel, ['cities'], NewItemType>;
        type Expected = {
            state: string;
            cities: KeyedArray<{ transformed: boolean }>;
        };
        // Use expectAssignable for structural compatibility (Omit creates intersection types)
        expectAssignable<Expected>({} as Result);
        expectAssignable<Result>({} as Expected);
    });

    it('should transform second level array item type', () => {
        type NewItemType = { newProp: number };
        type Result = TransformAtPath<InputWithTwoLevels, ['cities', 'venues'], NewItemType>;
        // The result should have cities with venues transformed
        type Expected = {
            state: string;
            cities: KeyedArray<{
                city: string;
                venues: KeyedArray<{ newProp: number }>;
            }>;
        };
        // Use expectAssignable for structural compatibility
        expectAssignable<Expected>({} as Result);
        expectAssignable<Result>({} as Expected);
    });

    it('should transform third level array item type', () => {
        type NewItemType = { deep: string };
        type Result = TransformAtPath<InputWithThreeLevels, ['states', 'cities', 'venues'], NewItemType>;
        // The result should preserve structure above the transformed level
        type Expected = {
            region: string;
            states: KeyedArray<{
                state: string;
                cities: KeyedArray<{
                    city: string;
                    venues: KeyedArray<{ deep: string }>;
                }>;
            }>;
        };
        // Use expectAssignable for structural compatibility
        expectAssignable<Expected>({} as Result);
        expectAssignable<Result>({} as Expected);
    });

    it('should preserve non-transformed properties at transformation level', () => {
        type InputWithMultipleProps = {
            state: string;
            otherProp: number;
            cities: KeyedArray<{
                city: string;
                population: number;
            }>;
        };
        type NewItemType = { replaced: boolean };
        type Result = TransformAtPath<InputWithMultipleProps, ['cities'], NewItemType>;
        type Expected = {
            state: string;
            otherProp: number;
            cities: KeyedArray<{ replaced: boolean }>;
        };
        // Use expectAssignable for structural compatibility
        expectAssignable<Expected>({} as Result);
        expectAssignable<Result>({} as Expected);
    });
});