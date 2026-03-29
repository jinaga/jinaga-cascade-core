# Type-Safe Test Data and Assertions

Prevents TypeScript test failures caused by property name mismatches, non-existent properties, and assertions on implementation-only types.

## Why This Matters

Common test breakages that type-safety prevents:

- **Wrong property names**: Tests use a different name than the real type (e.g. `groupByFields` vs `selectedProperties`, or `propertyName` vs `selectedProperty`). The compiler catches these only if test data is typed from the same source of truth.
- **Non-existent properties**: Tests assert on a property the public type does not have (e.g. the type has only `id` and `dataSourceId` but tests use `.steps` or `.config`). Implementation may use extended types internally; tests should not depend on those.
- **Stale assertions**: After a type refactor, tests still assert on old shapes unless they import and use the actual types.

## Rule 1: Import Types from Source of Truth

**Use the same type definitions as production.** Do not invent property names or inline object shapes.

### ✅ CORRECT – Typed from domain

```typescript
import type { Pipeline, Visualization } from '../../types/workspace';
import type { PipelineStepConfig } from '../../contexts/PipelineEditorContext';

// Helper return type matches the public type – only its declared properties are allowed
function givenPipeline(overrides?: Partial<Pipeline>): Pipeline {
  return { id: 'pipeline-1', dataSourceId: 'ds-1', ...overrides };
}

// Config object uses the actual property names from the type (not invented names)
function givenPipelineSteps(): PipelineStepConfig[] {
  return [
    { id: 'step-1', type: 'group-by', selectedProperties: ['category'], scopePath: [], arrayName: 'groups', isComplete: true },
    { id: 'step-2', type: 'drop-property', selectedProperty: 'internal_id', scopePath: [], isComplete: true },
  ];
}
```

### ❌ WRONG – Invented or outdated names

```typescript
// BAD: property names not on the real type (e.g. groupByFields / propertyName instead of selectedProperties / selectedProperty)
const steps = [
  { type: 'group-by', groupByFields: ['category'], ... },
  { type: 'drop-property', propertyName: 'internal_id', ... },
];

// BAD: object includes a property the public type doesn't have (e.g. steps when the type only has id and dataSourceId)
const pipeline = { id: 'p1', dataSourceId: 'ds1', steps: [] };

// BAD: asserting on a nested or non-existent property (e.g. .config when the type has flat fields)
expect(updatedViz.config.labelField).toBe('category');
```

**Checklist:** When adding or editing test data for a domain object, import its type from the same module as production and use that type (or `Partial<ThatType>`) for overrides. For unions or multi-variant config types, use a typed helper or satisfy the union so wrong property names fail at compile time.

## Rule 2: Assert Only on Public API Types

**Only assert on properties that exist on the public type.** Implementation may use extended or internal types; tests should not depend on those unless they are part of the documented, observable behavior.

### ✅ CORRECT – Assert on public shape

```typescript
// Assert only on properties that exist on the public type
expect(result.updatedWorkspace.pipelines[0]).toMatchObject({
  id: result.pipelineId,
  dataSourceId: result.dataSourceId,
});
// If the implementation stores more internally, add a short comment:
// "X is stored internally; the public type doesn't expose it."
```

### ❌ WRONG – Asserting on non-existent or internal properties

```typescript
// BAD: asserting on a property the public type doesn't have
expect(result.updatedWorkspace.pipelines[0].steps).toEqual([]);
expect(result.updatedWorkspace.pipelines[0]).toMatchObject({ steps: [] });

// BAD: asserting on a nested or non-existent property
expect(visualization.config.labelField).toBe('category');
```

When the implementation keeps extra data that the public type does not expose, assert only on the public properties and add a short comment so future readers know why you are not asserting on the internal field.

## Rule 3: Use Typed Test Helpers for Complex Shapes

For union types or config objects with many variants, prefer a small helper that returns the correct type so every test site gets the same property names and the compiler enforces them.

```typescript
// Example: helper for a union of step configs
function givenPipelineSteps(): PipelineStepConfig[] {
  return [
    {
      id: 'step-1',
      type: 'group-by',
      selectedProperties: ['category'],
      scopePath: [],
      arrayName: 'groups',
      isComplete: true,
    },
    {
      id: 'step-2',
      type: 'drop-property',
      selectedProperty: 'internal_id',
      scopePath: [],
      isComplete: true,
    },
  ];
}
```

If you need a one-off value in a test, still type it as the real type (or a specific variant) so typos or renamed properties cause a type error.

## Summary

1. **Source of truth**: Import domain types from the same modules as production; use them in test helpers and overrides.
2. **Public API only**: Assert only on properties that exist on the public type; comment when you intentionally skip internal-only fields.
3. **Typed helpers**: Use typed helpers for complex or union types so property names stay correct and the compiler catches mismatches.
