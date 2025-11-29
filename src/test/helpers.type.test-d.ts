import { expectType, expectError } from 'tsd';
import { createPipeline } from '../index';
import { BuilderOutputType } from './helpers';
import type { PipelineBuilder } from '../index';

// Test single key groupBy - this is the failing case from the user's example
{
    const builder = createPipeline<{ category: string; value: number }>()
        .groupBy(['category'], 'items');
    
    type Output = BuilderOutputType<typeof builder>;
    
    // Expected: { category: string; items: { value: number }[] }
    // This should pass if the fix is working
    expectType<{ category: string; items: { value: number }[] }>({} as Output);
    
    // This should cause a type error - 'value' should NOT be at the top level
    // We test this by trying to assign Output to a type that includes 'value' at top
    // If Output has 'value' at top, this assignment would work (but it shouldn't)
    expectError(
        (() => {
            const test: { category: string; value: number; items: { value: number }[] } = {} as Output;
            return test;
        })()
    );
    
    // Verify that items array contains objects with 'value' property
    expectType<{ value: number }[]>({} as Output['items']);
    
    // Diagnostic: Check if Output extends the wrong type (with value at top)
    type HasValueAtTop = Output extends { category: string; value: number; items: any[] } ? true : false;
    expectType<false>({} as HasValueAtTop); // Should be false
    
    // Diagnostic: Check if Output extends the correct type (value only in items)
    type HasCorrectStructure = Output extends { category: string; items: { value: number }[] } ? true : false;
    expectType<true>({} as HasCorrectStructure); // Should be true
}

// Test multiple key properties
{
    const builder = createPipeline<{ category: string; status: string; value: number }>()
        .groupBy(['category', 'status'], 'items');
    
    type Output = BuilderOutputType<typeof builder>;
    
    // Expected: { category: string; status: string; items: { value: number }[] }
    expectType<{ category: string; status: string; items: { value: number }[] }>({} as Output);
    
    // 'value' should NOT be at top level
    expectError(
        (() => {
            const test: { category: string; status: string; value: number; items: { value: number }[] } = {} as Output;
            return test;
        })()
    );
    
    // Diagnostic check
    type HasValueAtTop = Output extends { category: string; status: string; value: number; items: any[] } ? true : false;
    expectType<false>({} as HasValueAtTop);
}

// Test with computed properties before groupBy
{
    const builder = createPipeline<{ category: string; a: number; b: number }>()
        .defineProperty("sum", (item) => item.a + item.b)
        .groupBy(['category'], 'items');
    
    type Output = BuilderOutputType<typeof builder>;
    
    // Expected: { category: string; items: { a: number; b: number; sum: number }[] }
    expectType<{ category: string; items: { a: number; b: number; sum: number }[] }>({} as Output);
    
    // 'a', 'b', and 'sum' should NOT be at top level
    expectError(
        (() => {
            const test: { category: string; a: number; items: { a: number; b: number; sum: number }[] } = {} as Output;
            return test;
        })()
    );
}

// Additional diagnostic: Test the actual inferred type structure
{
    const builder = createPipeline<{ category: string; value: number }>()
        .groupBy(['category'], 'items');
    
    type Output = BuilderOutputType<typeof builder>;
    
    // This assignment should work - Output should be assignable to the correct type
    const correct: { category: string; items: { value: number }[] } = {} as Output;
    
    // This assignment should FAIL - Output should NOT be assignable to type with value at top
    expectError(
        (() => {
            const test: { category: string; value: number; items: { value: number }[] } = {} as Output;
            return test;
        })()
    );
}

// Deep diagnostic: Check what keys are actually in the type
{
    const builder = createPipeline<{ category: string; value: number }>()
        .groupBy(['category'], 'items');
    
    type Output = BuilderOutputType<typeof builder>;
    
    // Check what keys TypeScript sees
    type OutputKeys = keyof Output;
    // Should be 'category' | 'items', NOT including 'value'
    expectType<'category' | 'items'>({} as OutputKeys);
    
    // Check if 'value' is a key (it shouldn't be)
    type HasValueKey = 'value' extends keyof Output ? true : false;
    expectType<false>({} as HasValueKey);
}

