import { PipelineBuilder, type KeyedArray } from './builder';
import { createPipeline as createBasePipeline } from './factory';

/**
 * Example pipeline that groups items by category and computes aggregates
 * 
 * Input: Items with id, category, value, and name
 * Output: Categories with aggregated statistics about their items
 */

interface InputItem {
    id: string;
    category: string;
    value: number;
    name: string;
}

interface OutputCategory {
    category: string;
    items: KeyedArray<{
        id: string;
        value: number;
        name: string;
    }>;
    totalValue: number;
    itemCount: number;
    averageValue: number | undefined;
    maxValue: number | undefined;
    minValue: number | undefined;
    mostExpensiveItem: {
        id: string;
        value: number;
        name: string;
    } | undefined;
}

/**
 * Creates a pipeline that groups items by category and computes various aggregates
 * 
 * @param setState - Function to update the pipeline state
 * @returns A pipeline instance ready to process items
 */
export function createPipeline(setState: (transform: (state: KeyedArray<OutputCategory>) => KeyedArray<OutputCategory>) => void) {
    const builder = createBasePipeline<InputItem>();
    
    const pipeline = builder
        // Group items by category
        .groupBy(['category'], 'items')
        // Compute sum of all values in the category
        .sum('items', 'value', 'totalValue')
        // Count number of items in the category
        .count('items', 'itemCount')
        // Compute average value
        .average('items', 'value', 'averageValue')
        // Find maximum value
        .max('items', 'value', 'maxValue')
        // Find minimum value
        .min('items', 'value', 'minValue')
        // Pick the item with the highest value
        .pickByMax('items', 'value', 'mostExpensiveItem')
        // Build the pipeline
        .build(setState, builder.getTypeDescriptor());
    
    return pipeline;
}