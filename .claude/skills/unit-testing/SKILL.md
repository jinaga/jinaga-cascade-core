---
name: unit-testing
description: >-
  Provides Vitest unit-testing patterns for this monorepo: *.test.ts / *.spec.ts,
  describe/it structure, assertions, fakes over mocks, renderHook, DI, TDD. Covers
  TypeScript modules (validators, pipelineRunner, type-checking), React hooks and
  contexts, and async code. Use when adding, changing, or fixing unit tests, or when
  reviewing test changes.
---

# Unit Testing Patterns for TypeScript

Vitest setup, test data helpers, fakes, React patterns, and TDD workflows are covered below; deeper detail lives under `patterns/` and `examples/`.

## Core Philosophy: Fakes First

**CRITICAL: Default to fakes for any code involving async operations, callbacks, or state changes.** Fakes provide explicit control over timing and eliminate flaky tests.

**DO NOT MOCK YOUR OWN CODE.** Mocking internal dependencies (your hooks, contexts, utilities) tests implementation details rather than behavior, making tests brittle and worthless.

Use mocks (`vi.mock()`) ONLY for:
- Third-party APIs (Tauri, browsers, external services)
- When you literally cannot inject the dependency any other way

**NEVER mock:**
- Your own React hooks (`useWindow`, `useAppNavigation`, custom hooks)
- Your own contexts or context providers
- Your own utilities or helper functions
- Internal module dependencies

Use fakes with dependency injection instead—they test behavior, not implementation.

## TDD Philosophy

**TDD is about unit tests only.** Unit tests drive implementation using vitest for fast, isolated testing with minimal dependencies.

**Integration tests follow implementation.** They use real dependencies to verify complex interactions, API contracts, and system integration.

## Test Structure

- **AAA Pattern**: Arrange-Act-Assert with Given-When-Then comments
- **Test Naming**: Descriptive `it('should...')` statements that explain behavior
- **Given-When-Then Comments**: Describe test flow and intent for clarity
- **describe/it blocks**: Organize tests by feature or function

## Behavior vs Implementation Testing

**Core Principle**: Test WHAT your code does (observable behavior), not HOW it does it (implementation details).

### Implementation Testing (❌ BAD)
Tests that break when you refactor code structure, even though behavior hasn't changed:
- Verifying which internal functions are called
- Checking that specific hooks are invoked (`expect(useWindow).toHaveBeenCalled()`)
- Asserting on internal state structure
- Mocking internal dependencies (your own hooks, utilities)

### Behavior Testing (✅ GOOD)
Tests that verify user-visible outcomes and remain stable during refactoring:
- Checking that data is updated correctly
- Verifying navigation occurred to the right place
- Asserting that side effects were triggered
- Using fakes for dependencies (contexts, APIs)

### Assert expected behavior

Tests assert the **specification**: correct outcomes, not thrown errors, wrong values, or messages that exist only because of a defect. When implementation is wrong, write the test to the spec and accept a failing test until it is fixed (red, then green).

### React Hooks: Common Anti-Pattern

❌ **BAD** - Testing implementation:
```typescript
// Mocking internal hooks to verify they're called
vi.mock('../useWindow');
vi.mock('../useAppNavigation');

it('should access WindowContext via useWindow', () => {
  renderHook(() => useMyCommand());
  expect(useWindow).toHaveBeenCalled(); // ❌ Tests HOW context is accessed
});
```

✅ **GOOD** - Testing behavior:
```typescript
// Using fakes injected via providers
it('should update workspace when command is called', async () => {
  const fakeContext = new FakeWindowContext(givenWorkspace());
  const wrapper = createTestWrapper({ windowContext: fakeContext });
  
  const { result } = renderHook(() => useMyCommand(), { wrapper });
  await act(() => result.current.myCommand('/path/to/file'));
  
  expect(fakeContext.updateWorkspaceCalls).toHaveLength(1); // ✅ Tests WHAT happened
  expect(fakeContext.workspace.dataSources).toHaveLength(1); // ✅ Observable outcome
});
```

### When Mocks Are Acceptable

✅ Mock **third-party APIs** (external systems you don't control):
- Tauri `invoke()` calls
- Browser APIs (`fetch`, `localStorage`)
- External services

❌ Don't mock **your own code** (internal dependencies you control):
- Your hooks (`useWindow`, `useAppNavigation`)
- Your utilities and helpers
- Your context providers

Use fakes instead - they're more realistic and reusable.

## Vitest Configuration

- Use `globals: true` for `describe`, `it`, `expect` without imports
- Set `environment: 'node'` for Node.js code, `'jsdom'` for DOM-dependent code
- Configure `include` patterns to match test files (`**/*.test.ts`, `**/*.spec.ts`)
- Use `pool: 'forks'` for better isolation when needed

## Test Data Helper Patterns

Create test data factories and helpers that:
- Use sensible defaults for optional properties
- Accept partial overrides for flexibility — each test specifies only the values relevant to its scenario
- Return properly typed objects matching your domain models
- **Use types from the same source of truth as production** — import domain types (e.g. `Pipeline`, `PipelineStepConfig`) and use them in helpers and overrides so wrong property names cause compile errors.
- Use faker or similar libraries for realistic random data when appropriate
- Avoid hardcoded test data that creates maintenance burden

When a helper must also **insert into a repository or container**, use a class that receives the container via the constructor, with an `add()` method that calls the factory function and inserts. This keeps the side effect explicit and avoids hidden global state. See [patterns/test-data-helpers.md](patterns/test-data-helpers.md) for the full pattern.

Eliminate repetitive `beforeEach` blocks by replacing them with `given*` helpers — each test should call helpers directly with only the overrides that matter for that scenario.

**Assert only on public API types.** Do not assert on properties that are not on the public type (e.g. internal extended types like `PipelineWithSteps`); add a comment when you omit internal-only fields. See [patterns/type-safe-test-data.md](patterns/type-safe-test-data.md).

Example pattern:
```typescript
function givenUser(overrides?: Partial<User>): User {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    ...overrides
  };
}
```

## Fake Implementations Strategy

**Fakes are the default.** A fake implements the same interface as the production component but provides an in-memory simulation with explicit test control.

Benefits over mocks:
- **Deterministic timing**: Control when async operations complete
- **No hoisting surprises**: No `vi.mock()` order-of-execution issues
- **Full TypeScript support**: Fakes implement interfaces with type safety
- **Better test readability**: `fake.complete()` is clearer than mock callback coordination

Fake pattern:
- Implement the full interface
- Store resolve/reject functions for async control
- Provide `complete()`, `fail()`, `emitProgress()` test control methods
- Add test helpers like `getCallCount()`, `hasPendingOperation()`

## Test Isolation

- Each test should be independent and runnable in any order
- Use `beforeEach`/`afterEach` for setup/teardown when needed
- Avoid shared mutable state between tests
- Use test helpers to create fresh instances for each test

## Best Practices

1. Use AAA Pattern with Given-When-Then comments
2. Write descriptive test names that explain expected behavior
3. One assertion per test when possible (atomic tests)
4. Test behavior, not implementation details
5. Use test data helpers with sensible defaults
6. **Favor fakes over mocks** for dependencies
7. Focus unit tests on business logic and pure functions
8. Keep tests fast and isolated
9. Use `describe` blocks to group related tests
10. Prefer `toBe` for primitives, `toEqual` for objects/arrays
11. For async command hooks on shared resources, include tests for out-of-order completion and latest-wins/serialization guarantees
12. Assert expected behavior (see **Assert expected behavior** above); never treat defective output as the passing bar

## Common Patterns

### Testing Pure Functions
```typescript
describe('calculateTotal', () => {
  it('should sum all items', () => {
    // Given
    const items = [10, 20, 30];
    
    // When
    const result = calculateTotal(items);
    
    // Then
    expect(result).toBe(60);
  });
});
```

### Testing with Fakes
```typescript
describe('processPayment', () => {
  it('should process payment successfully', async () => {
    // Given: A fake payment gateway with initial state
    const fakeGateway = new FakePaymentGateway();
    const service = new PaymentService(fakeGateway);
    
    // When: Processing a payment
    await service.processPayment(100);
    
    // Then: Payment is recorded in the fake
    expect(fakeGateway.getPayments()).toHaveLength(1);
    expect(fakeGateway.getPayments()[0].amount).toBe(100);
  });
});
```

### Testing Async Code
```typescript
describe('fetchUserData', () => {
  it('should return user data', async () => {
    // Given
    const userId = '123';
    
    // When
    const user = await fetchUserData(userId);
    
    // Then
    expect(user).toHaveProperty('id', userId);
  });
});
```

## Testing Fire-and-Forget Hooks

Hooks that use `useWorkspaceCommand` or `useSnackBar` require special test setup because they perform async work internally but return `void` to callers.

### SnackBarContext is required

Any hook using `useWorkspaceCommand` or `useSnackBar` needs `SnackBarContext.Provider` in the test wrapper. Use a mock value:

```typescript
import { SnackBarContext } from '../../contexts/SnackBarContext';

const snackBarContextValue = { showSnackBar: vi.fn() };

// In wrapper:
createElement(SnackBarContext.Provider, { value: snackBarContextValue }, children)
```

### Flushing microtasks for fire-and-forget hooks

When a hook returns `void` but does async work internally (via IIFE), tests must flush microtasks after calling the hook:

```typescript
await act(async () => {
  result.current.commandFunction(args);
  await new Promise(resolve => setTimeout(resolve, 0));
});
// Now assertions about mocks will work
```

The `setTimeout(resolve, 0)` ensures the internal `void (async () => { ... })()` IIFE completes before assertions run.

### Test ordering guarantees for shared-resource commands

When commands can be invoked rapidly for the same resource key, add deterministic race tests and assert the selected ordering policy.

Use [../async-command-serialization/SKILL.md](../async-command-serialization/SKILL.md) as the canonical source for policy definitions and test expectations.

### Test error display via SnackBar

Since errors are shown via SnackBar (not just `console.warn`), tests should assert on `showSnackBar` being called with the expected error message:

```typescript
expect(mockShowSnackBar).toHaveBeenCalledWith({
  message: 'No workspace is currently open',
  variant: 'error',
});
```

## Resources

- **[patterns/react-hooks-testing-anti-patterns.md](patterns/react-hooks-testing-anti-patterns.md)**: ⚠️ CRITICAL - Common mistakes when testing React hooks. Read this FIRST to avoid mocking your own code.
- [../async-command-serialization/SKILL.md](../async-command-serialization/SKILL.md): Canonical async command policy and race-testing expectations.
- [patterns/fake-implementations.md](patterns/fake-implementations.md): Detailed fake patterns for repositories, services, and API clients. Includes when to use fakes vs mocks.
- [patterns/react-testing.md](patterns/react-testing.md): React-specific patterns including renderHook, context testing, dependency injection, and async fakes. **When testing context providers with a consumer component:** read "Stale context reference after act()" in Common Pitfalls — re-capture context after each `act()` that changes state.
- [patterns/test-data-helpers.md](patterns/test-data-helpers.md): Test data factories with sensible defaults and partial overrides.
- [patterns/type-safe-test-data.md](patterns/type-safe-test-data.md): Match source-of-truth types, assert only on public API, avoid property name mismatches and non-existent properties in tests.
- [examples/service-tests.md](examples/service-tests.md): Concrete service test examples using fakes and dependency injection.
- [examples/domain-tests.md](examples/domain-tests.md): Testing domain objects, value objects, and pure functions.
