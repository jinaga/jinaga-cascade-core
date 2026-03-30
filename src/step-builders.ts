import type {
    PipelineInput,
    PipelineSources,
    Step,
    StepBuilder
} from './pipeline.js';
import { EnrichBuilder, EnrichStep } from './steps/enrich.js';
import { InputStep } from './factory.js';

export type EnrichDiagnostic = {
    code:
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
};

interface BuiltStepGraph {
    rootInput: PipelineInput<unknown, Record<string, unknown>>;
    lastStep: Step;
}

type RootPipelineStep = Step & PipelineInput<unknown, Record<string, unknown>>;

function isPipelineInput(step: Step): step is RootPipelineStep {
    return (
        typeof (step as unknown as PipelineInput<unknown, Record<string, unknown>>).add === 'function' &&
        typeof (step as unknown as PipelineInput<unknown, Record<string, unknown>>).remove === 'function' &&
        typeof (step as unknown as PipelineInput<unknown, Record<string, unknown>>).sources === 'object'
    );
}

export function buildStepGraph(
    lastBuilder: StepBuilder,
    emitDiagnostic?: (diagnostic: EnrichDiagnostic) => void
): BuiltStepGraph {
    const builderChain: StepBuilder[] = [];
    let currentBuilder: StepBuilder | undefined = lastBuilder;
    while (currentBuilder) {
        builderChain.push(currentBuilder);
        currentBuilder = currentBuilder.upstream;
    }
    builderChain.reverse();

    if (builderChain.length === 0) {
        throw new Error('Cannot build pipeline without at least one builder.');
    }

    const rootStep = builderChain[0].buildStep(undefined as unknown as Step);
    if (!isPipelineInput(rootStep)) {
        throw new Error('Root builder did not produce a PipelineInput-compatible step.');
    }

    let lastStep: Step = rootStep;
    const sources: Record<string, PipelineInput<unknown, Record<string, unknown>>> = {};

    for (let index = 1; index < builderChain.length; index += 1) {
        const builder = builderChain[index];
        if (builder instanceof EnrichBuilder) {
            const secondaryGraph = buildStepGraph(builder.secondaryLastBuilder, emitDiagnostic);
            sources[builder.sourceName] = secondaryGraph.rootInput;
            lastStep = new EnrichStep(
                lastStep,
                secondaryGraph.lastStep,
                builder.scopeSegments,
                builder.primaryKey,
                builder.asProperty,
                builder.whenMissing,
                emitDiagnostic
            );
            continue;
        }

        lastStep = builder.buildStep(lastStep);
    }

    if (rootStep instanceof InputStep) {
        rootStep.setSources(sources as PipelineSources<Record<string, unknown>>);
    }

    return {
        rootInput: rootStep,
        lastStep
    };
}
