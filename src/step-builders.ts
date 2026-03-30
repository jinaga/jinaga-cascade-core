import type {
    BuildContext,
    BuiltStepGraph,
    StepBuilder
} from './pipeline.js';

export type EnrichDiagnostic = {
    code:
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
};

export function buildStepGraph(
    lastBuilder: StepBuilder,
    emitDiagnostic?: (diagnostic: EnrichDiagnostic) => void
): BuiltStepGraph {
    const ctx: BuildContext = { emitDiagnostic };
    const graph = lastBuilder.buildGraph(ctx);
    graph.rootInput.setSources(graph.sources);

    return graph;
}
