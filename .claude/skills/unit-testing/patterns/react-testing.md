# React Testing Patterns

Testing patterns for React hooks, contexts, and components using renderHook and dependency injection.

## Table of Contents

1. [Testing Hooks with renderHook](#testing-hooks-with-renderhook)
2. [Dependency Injection for Contexts](#dependency-injection-for-contexts)
3. [Async Fakes for React](#async-fakes-for-react)
4. [Common Patterns](#common-patterns)
5. [Common Pitfalls](#common-pitfalls) — including [Stale context reference after act()](#-stale-context-reference-after-act)

## Testing Hooks with renderHook

**Use `renderHook` from `@testing-library/react`** instead of TestConsumer patterns.

```typescript
import { renderHook, act } from '@testing-library/react';

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MyProvider>{children}</MyProvider>;
  };
}

it('should handle async operations', async () => {
  const { result } = renderHook(() => useMyHook(), {
    wrapper: createWrapper(),
  });

  // result.current always reflects latest state
  await act(async () => {
    await result.current.doSomething();
  });

  expect(result.current.state).toBe('expected');
});
```

### Why Not TestConsumer?

```typescript
// DON'T - Captures snapshot that becomes stale
function TestConsumer({ onContext }) {
  const context = useMyContext();
  onContext(context); // Snapshot at render time
  return null;
}
```

TestConsumer captures context during render. For async operations:
- The captured reference becomes stale after state updates
- Timing coordination with mocks is unpredictable
- Intermediate state observation is impossible

**If you must test a provider with a consumer component** (e.g. no hook to use with renderHook), never assert on the context reference you captured *before* a state change. After any `act()` that updates provider state, the provider creates a **new** context value; your callback will run again and update the variable. Re-read that variable (or call your assert helper again) *after* `act()` and assert on the fresh reference. See [Common Pitfalls: Stale context reference after act()](#-stale-context-reference-after-act).

## Dependency Injection for Contexts

Make contexts testable by accepting dependencies as props with sensible defaults.

```typescript
// Define service interface
export interface DataService {
  fetchData: (id: string) => Promise<Data>;
}

// Default uses real implementation
const defaultService: DataService = { fetchData: realFetchData };

// Provider accepts optional service for testing
export function DataProvider({
  children,
  dataService = defaultService,
}: {
  children: React.ReactNode;
  dataService?: DataService;
}) {
  const handleFetch = useCallback(async (id: string) => {
    return dataService.fetchData(id);
  }, [dataService]);
  // ...
}
```

**Benefits:**
- Production code unchanged (default provides real implementation)
- No `vi.mock()` needed - inject fake directly
- Full TypeScript support via interface
- Explicit dependencies

## Async Fakes for React

Fakes with explicit async control for deterministic tests.

```typescript
class FakeDataService implements DataService {
  private pending = new Map<string, {
    resolve: (value: Data) => void;
    reject: (error: Error) => void;
    onProgress?: (result: Data, progress: Progress) => void;
  }>();
  private callHistory: string[] = [];

  async fetchData(id: string): Promise<Data> {
    this.callHistory.push(id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  // Test control methods
  complete(id: string, data: Data): boolean {
    const op = this.pending.get(id);
    if (op) {
      op.resolve(data);
      this.pending.delete(id);
      return true;
    }
    return false;
  }

  fail(id: string, error: Error): boolean {
    const op = this.pending.get(id);
    if (op) {
      op.reject(error);
      this.pending.delete(id);
      return true;
    }
    return false;
  }

  emitProgress(id: string, result: Data, progress: Progress): boolean {
    const op = this.pending.get(id);
    if (op?.onProgress) {
      op.onProgress(result, progress);
      return true;
    }
    return false;
  }

  // Test helpers
  getCallCount(): number { return this.callHistory.length; }
  hasPendingOperation(id: string): boolean { return this.pending.has(id); }
}
```

## Common Patterns

### Caching and Cache Hits

```typescript
it('should return cached results without reprocessing', async () => {
  const fake = new FakeDataService();
  const { result } = renderHook(() => useData(), {
    wrapper: ({ children }) => (
      <DataProvider dataService={fake}>{children}</DataProvider>
    ),
  });

  // First call - processes
  await act(async () => {
    const promise = result.current.fetch('item-1');
    fake.complete('item-1', mockData);
    await promise;
  });

  const callsBefore = fake.getCallCount();

  // Second call - uses cache
  await act(async () => {
    await result.current.fetch('item-1');
  });

  expect(fake.getCallCount()).toBe(callsBefore); // No new calls
});
```

### Progress Updates

```typescript
it('should report progress during processing', async () => {
  const fake = new FakeDataService();
  const { result } = renderHook(() => useData(), { wrapper });

  await act(async () => {
    const promise = result.current.process('item-1');

    // Emit progress at controlled time
    fake.emitProgress('item-1', partialData, { percent: 50 });

    // Check intermediate state
    expect(result.current.progress).toBe(50);

    fake.complete('item-1', finalData);
    await promise;
  });
});
```

### Concurrent Request Deduplication

```typescript
it('should deduplicate concurrent requests', async () => {
  const fake = new FakeDataService();
  const { result } = renderHook(() => useData(), { wrapper });

  await act(async () => {
    const promise1 = result.current.fetch('item-1');
    const promise2 = result.current.fetch('item-1');

    expect(fake.getCallCount()).toBe(1); // Only one call

    fake.complete('item-1', mockData);
    const [r1, r2] = await Promise.all([promise1, promise2]);

    expect(r1).toEqual(r2); // Both get same result
  });
});
```

## Common Pitfalls

### ❌ Forgetting act() for State Updates

```typescript
// Wrong
result.current.updateSomething(); // React warning

// Correct
act(() => {
  result.current.updateSomething();
});
```

### ❌ Checking State Before Fake Completes

```typescript
// Wrong - checking while promise pending
await act(async () => {
  result.current.fetch('item-1');
  expect(result.current.data).toEqual(mockData); // ❌ Not yet!
});

// Correct
await act(async () => {
  const promise = result.current.fetch('item-1');
  fake.complete('item-1', mockData);
  await promise;
});
expect(result.current.data).toEqual(mockData); // ✅ After completion
```

### ❌ Using Old Context Reference

```typescript
// Wrong - captured reference may be stale
const ctx = result.current;
await act(async () => { await ctx.doSomething(); });
expect(ctx.state).toBe('new'); // ❌ Might fail

// Correct - always use result.current
await act(async () => { await result.current.doSomething(); });
expect(result.current.state).toBe('new'); // ✅
```

### ❌ Stale context reference after act()

When testing a **context provider** with a TestConsumer that assigns context to a variable (e.g. `onContext={(ctx) => { context = ctx; }}`), the provider creates a **new** context value object on each state update. The variable is updated by the callback on the next render, but any variable you captured *before* `act()` still points at the old object. Asserting on that old reference makes it look like "state didn't change."

```typescript
// Wrong - ctx is the pre-act() reference; state did change but ctx didn't
const ctx = assertContext(context);
act(() => { ctx.transitions.startEditingPipeline('pipe-1'); });
expect(ctx.navigationState).toEqual({ state: 'pipeline-edit', pipelineId: 'pipe-1' }); // ❌ Fails: ctx is stale

// Correct - re-capture context after the state update
const ctx = assertContext(context);
act(() => { ctx.transitions.startEditingPipeline('pipe-1'); });
const updated = assertContext(context); // Re-read the variable the consumer updates
expect(updated.navigationState).toEqual({ state: 'pipeline-edit', pipelineId: 'pipe-1' }); // ✅
```

**Rule:** After any `act()` that changes provider state, re-read the context (e.g. `assertContext(context)` or use the updated variable) before asserting on `navigationState`, `resolvedEntities`, or other context-derived values. For multi-step transitions, re-capture after each step and use the fresh reference for the next transition call.

### ❌ Not Awaiting Async Operations

```typescript
// Wrong - test may finish before operation
act(() => {
  result.current.processData('item-1'); // Not awaited!
});

// Correct
await act(async () => {
  const promise = result.current.processData('item-1');
  fake.complete('item-1', mockData);
  await promise;
});
```
