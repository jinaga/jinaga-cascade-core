import * as fs from 'fs';
import { computeGroupKey } from './util/hash';
import type { KeyedArray } from './builder';

/**
 * Pipeline runner script that processes JSON input through a pipeline
 *
 * Usage: ts-node src/run-pipeline.ts <input.json> <output.json>
 *
 * The input JSON should be an array of objects. Each object will be automatically
 * assigned a unique ID based on a hash of all its properties.
 *
 * Example input:
 * [
 *   { "category": "A", "value": 100, "name": "Item 1" },
 *   { "category": "B", "value": 200, "name": "Item 2" },
 *   ...
 * ]
 */

async function main() {
    // Parse command-line arguments
    const args = process.argv.slice(2);
    
    if (args.length !== 2) {
        console.error('Usage: ts-node src/run-pipeline.ts <input.json> <output.json>');
        console.error('');
        console.error('Example:');
        console.error('  ts-node src/run-pipeline.ts sample-input.json output.json');
        process.exit(1);
    }
    
    const [inputPath, outputPath] = args;
    
    // Validate input file exists
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file '${inputPath}' not found`);
        process.exit(1);
    }
    
    try {
        // Read and parse input JSON
        console.log(`Reading input from: ${inputPath}`);
        const inputData: unknown = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
        
        if (!Array.isArray(inputData)) {
            throw new Error('Input JSON must be an array of objects');
        }
        
        console.log(`Processing ${inputData.length} items...`);
        
        // Import the pipeline builder
        const { createPipeline } = await import('./example-pipeline');
        
        // Create the pipeline with a state setter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime JSON data, typed by pipeline
        let currentState: KeyedArray<any> = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime JSON data, typed by pipeline
        const setState = (transform: (state: KeyedArray<any>) => KeyedArray<any>) => {
            currentState = transform(currentState);
        };
        
        const pipeline = createPipeline(setState);
        
        // Process each item through the pipeline
        inputData.forEach((item: unknown) => {
            // Type guard: ensure item is an object
            if (typeof item !== 'object' || item === null) {
                throw new Error('Input array must contain objects');
            }
            
            // Generate a unique ID based on all properties of the item
            const itemObj = item as Record<string, unknown>;
            const itemId = computeGroupKey(itemObj, Object.keys(itemObj));
            
            // Runtime script: item structure validated by pipeline at runtime
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Runtime JSON data structure
            pipeline.add(itemId, item as any);
        });
        
        // Write results to output file
        console.log(`Writing results to: ${outputPath}`);
        fs.writeFileSync(outputPath, JSON.stringify(currentState, null, 2), 'utf-8');
        
        console.log('✓ Pipeline execution completed successfully');
        console.log(`✓ Output written to: ${outputPath}`);
        console.log(`✓ Generated ${currentState.length} result items`);
        
    } catch (error) {
        console.error('Error processing pipeline:');
        if (error instanceof Error) {
            console.error(error.message);
            if (error.stack) {
                console.error('\nStack trace:');
                console.error(error.stack);
            }
        } else {
            console.error(error);
        }
        process.exit(1);
    }
}

main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
});