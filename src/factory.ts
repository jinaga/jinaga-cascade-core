import { PipelineBuilder } from './builder.js';
import { type ScalarDescriptor } from './pipeline.js';
import { InputBuilder } from './step-builders.js';

export function createPipeline<TStart extends object>(): PipelineBuilder<TStart, TStart, [], 'items'>;
export function createPipeline<TStart extends object, TRootScopeName extends string>(
    rootScopeName: TRootScopeName,
    sourceScalars?: ScalarDescriptor[]
): PipelineBuilder<TStart, TStart, [], TRootScopeName>;
/**
 * Create a pipeline builder.
 * Call `.build(setState, runtimeOptions?)` on the returned builder to create
 * an isolated runtime session with explicit lifecycle controls.
 */
export function createPipeline<TStart extends object>(
    rootScopeName: string = 'items',
    sourceScalars: ScalarDescriptor[] = []
): PipelineBuilder<TStart, TStart, [], string, Record<never, never>> {
    const rootBuilder = new InputBuilder<TStart>(rootScopeName, sourceScalars);
    return new PipelineBuilder<TStart, TStart, [], string, Record<never, never>>(rootBuilder, rootBuilder);
}

