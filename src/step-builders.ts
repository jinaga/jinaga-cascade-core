import type {
    BuildContext,
    BuiltStepGraph,
    PipelineInput,
    PipelineSources,
    Step,
    StepBuilder
} from './pipeline.js';
import { InputStep } from './factory.js';

export type EnrichDiagnostic = {
    code:
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
};

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
    const ctx: BuildContext = { emitDiagnostic };
    const graph = lastBuilder.buildGraph(ctx);

    if (!isPipelineInput(graph.rootInput as unknown as Step)) {
        throw new Error('Root builder did not produce a PipelineInput-compatible step.');
    }

    if (graph.rootInput instanceof InputStep) {
        graph.rootInput.setSources(graph.sources as PipelineSources<Record<string, unknown>>);
    }

    return graph;
}
