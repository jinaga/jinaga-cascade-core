# Fake Implementations for TypeScript Tests

Detailed patterns for creating fake implementations of dependencies in TypeScript unit tests.

## Why Fakes?

**Favor fakes over mocks.** A fake implements the same interface as the production component but provides an in-memory simulation of its behavior.

### Benefits of Fakes

- **Full interface implementation**: Same contract as production code, catches interface changes
- **In-memory simulation**: Fast execution, no external dependencies
- **Configurable initial state**: Set up test data before the test runs
- **State-based assertions**: Verify final state, not implementation details
- **Better test readability**: Tests focus on behavior, not method calls
- **Easier maintenance**: Changes to interface are caught at compile time

### When to Use Fakes

✅ **Use fakes for:**
- Repositories and data stores
- Service dependencies
- Internal APIs and services
- Any dependency with a clear interface

❌ **Use mocks only when:**
- The dependency is truly external and cannot be faked (e.g., third-party APIs)
- You need to verify specific call patterns (rare in unit tests)
- The interface is too complex to implement a fake

## Fake Pattern

### Basic Fake Implementation

```typescript
// Production interface
interface UserRepository {
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
}

// Fake implementation
class FakeUserRepository implements UserRepository {
  private users: Map<string, User> = new Map();

  // Configure initial state
  withUser(user: User): this {
    this.users.set(user.id, user);
    return this;
  }

  withUsers(users: User[]): this {
    users.forEach(user => this.users.set(user.id, user));
    return this;
  }

  // Implement interface methods
  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async save(user: User): Promise<User> {
    this.users.set(user.id, user);
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return user;
      }
    }
    return null;
  }

  // Test helpers for assertions
  getUserCount(): number {
    return this.users.size;
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }
}
```

### Usage in Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { UserService } from './userService';
import { FakeUserRepository } from './fakeUserRepository';
import { givenUser } from './test-helpers';

describe('UserService', () => {
  it('should create a new user', async () => {
    // Given: A fake repository with initial state
    const fakeRepo = new FakeUserRepository();
    const service = new UserService(fakeRepo);

    // When: Creating a user
    const newUser = givenUser({ email: 'test@example.com' });
    const result = await service.createUser(newUser);

    // Then: User is saved in the fake
    expect(fakeRepo.getUserCount()).toBe(1);
    expect(fakeRepo.getUser(result.id)).toEqual(result);
  });

  it('should find user by email', async () => {
    // Given: A fake repository with existing user
    const existingUser = givenUser({ email: 'existing@example.com' });
    const fakeRepo = new FakeUserRepository().withUser(existingUser);
    const service = new UserService(fakeRepo);

    // When: Finding user by email
    const result = await service.findUserByEmail('existing@example.com');

    // Then: Returns the user
    expect(result).toEqual(existingUser);
  });
});
```

## Fake Patterns by Type

### Repository Fake

```typescript
interface ShowRepository {
  findById(id: string): Promise<Show | null>;
  findByVenueId(venueId: string): Promise<Show[]>;
  save(show: Show): Promise<Show>;
  delete(id: string): Promise<void>;
}

class FakeShowRepository implements ShowRepository {
  private shows: Map<string, Show> = new Map();

  withShow(show: Show): this {
    this.shows.set(show.id, show);
    return this;
  }

  withShows(shows: Show[]): this {
    shows.forEach(show => this.shows.set(show.id, show));
    return this;
  }

  async findById(id: string): Promise<Show | null> {
    return this.shows.get(id) ?? null;
  }

  async findByVenueId(venueId: string): Promise<Show[]> {
    return Array.from(this.shows.values())
      .filter(show => show.venueId === venueId);
  }

  async save(show: Show): Promise<Show> {
    this.shows.set(show.id, show);
    return show;
  }

  async delete(id: string): Promise<void> {
    this.shows.delete(id);
  }

  // Test helpers
  getShowCount(): number {
    return this.shows.size;
  }

  getShowsByVenue(venueId: string): Show[] {
    return this.findByVenueId(venueId);
  }
}
```

### Service Fake

```typescript
interface EmailService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendBulkEmail(recipients: string[], subject: string, body: string): Promise<void>;
}

class FakeEmailService implements EmailService {
  private sentEmails: Array<{ to: string; subject: string; body: string }> = [];

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    this.sentEmails.push({ to, subject, body });
  }

  async sendBulkEmail(recipients: string[], subject: string, body: string): Promise<void> {
    recipients.forEach(to => {
      this.sentEmails.push({ to, subject, body });
    });
  }

  // Test helpers
  getSentEmails(): Array<{ to: string; subject: string; body: string }> {
    return [...this.sentEmails];
  }

  getEmailCount(): number {
    return this.sentEmails.length;
  }

  hasEmailTo(email: string): boolean {
    return this.sentEmails.some(e => e.to === email);
  }

  clear(): void {
    this.sentEmails = [];
  }
}
```

### API Client Fake

```typescript
interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data: unknown): Promise<T>;
  put<T>(path: string, data: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

class FakeApiClient implements ApiClient {
  private responses: Map<string, unknown> = new Map();
  private requests: Array<{ method: string; path: string; data?: unknown }> = [];

  // Configure responses
  withResponse(path: string, response: unknown): this {
    this.responses.set(path, response);
    return this;
  }

  async get<T>(path: string): Promise<T> {
    this.requests.push({ method: 'GET', path });
    const response = this.responses.get(path);
    if (response === undefined) {
      throw new Error(`No response configured for GET ${path}`);
    }
    return response as T;
  }

  async post<T>(path: string, data: unknown): Promise<T> {
    this.requests.push({ method: 'POST', path, data });
    const response = this.responses.get(path);
    return (response ?? data) as T;
  }

  async put<T>(path: string, data: unknown): Promise<T> {
    this.requests.push({ method: 'PUT', path, data });
    const response = this.responses.get(path);
    return (response ?? data) as T;
  }

  async delete(path: string): Promise<void> {
    this.requests.push({ method: 'DELETE', path });
  }

  // Test helpers
  getRequests(): Array<{ method: string; path: string; data?: unknown }> {
    return [...this.requests];
  }

  clear(): void {
    this.requests = [];
    this.responses.clear();
  }
}
```

## Best Practices

### 1. Implement the Full Interface

```typescript
// ✅ Good - Implements all interface methods
class FakeRepository implements Repository {
  async findById(id: string): Promise<Entity | null> { /* ... */ }
  async save(entity: Entity): Promise<Entity> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
}

// ❌ Bad - Missing methods
class FakeRepository implements Repository {
  async findById(id: string): Promise<Entity | null> { /* ... */ }
  // Missing save and delete methods
}
```

### 2. Provide Test Helpers

```typescript
class FakeRepository {
  // Interface methods
  async findById(id: string): Promise<Entity | null> { /* ... */ }

  // Test helpers for assertions
  getEntityCount(): number { /* ... */ }
  getAllEntities(): Entity[] { /* ... */ }
  hasEntity(id: string): boolean { /* ... */ }
}
```

### 3. Support Initial State Configuration

```typescript
// ✅ Good - Fluent interface for setup
const fakeRepo = new FakeRepository()
  .withEntity(entity1)
  .withEntity(entity2);

// ✅ Also good - Array setup
const fakeRepo = new FakeRepository()
  .withEntities([entity1, entity2]);
```

### 4. Assert on State, Not Calls

```typescript
// ✅ Good - Assert on final state
it('should save user', async () => {
  const fakeRepo = new FakeUserRepository();
  await service.createUser(user);
  
  expect(fakeRepo.getUserCount()).toBe(1);
  expect(fakeRepo.getUser(user.id)).toEqual(user);
});

// ❌ Bad - Assert on method calls (this is mocking, not faking)
it('should save user', async () => {
  const mockRepo = { save: vi.fn() };
  await service.createUser(user);
  
  expect(mockRepo.save).toHaveBeenCalledWith(user);
});
```

### 5. Keep Fakes Simple

```typescript
// ✅ Good - Simple in-memory implementation
class FakeRepository {
  private entities: Map<string, Entity> = new Map();
  
  async findById(id: string): Promise<Entity | null> {
    return this.entities.get(id) ?? null;
  }
}

// ❌ Bad - Over-engineered with unnecessary complexity
class FakeRepository {
  private entities: Map<string, Entity> = new Map();
  private indexes: Map<string, Set<string>> = new Map();
  private cache: LRUCache<string, Entity> = new LRUCache();
  // ... too complex for a fake
}
```

## Common Anti-Patterns

### ❌ Verifying Method Calls

```typescript
// Don't do this - this is mocking, not faking
class FakeRepository {
  findByIdCallCount = 0;
  
  async findById(id: string): Promise<Entity | null> {
    this.findByIdCallCount++;
    // ...
  }
}

// In test
expect(fakeRepo.findByIdCallCount).toBe(1); // ❌ Don't verify calls
```

### ❌ Partial Interface Implementation

```typescript
// Don't skip methods - implement the full interface
class FakeRepository implements Repository {
  async findById(id: string): Promise<Entity | null> { /* ... */ }
  // Missing other methods - ❌ breaks interface contract
}
```

### ❌ Complex Business Logic in Fakes

```typescript
// Keep fakes simple - don't replicate business logic
class FakeRepository {
  async findById(id: string): Promise<Entity | null> {
    // ❌ Don't add validation, business rules, etc.
    if (!id || id.length < 3) {
      throw new Error('Invalid ID');
    }
    // Just return what's in memory
    return this.entities.get(id) ?? null;
  }
}
```

## When Mocks Are Still Needed

Use mocks (`vi.fn()`, `vi.mock()`) when:

1. **Truly external dependencies**: Third-party APIs, file system, network
2. **Complex external interfaces**: When implementing a fake would be too complex
3. **Testing error scenarios**: When you need to simulate specific error conditions

```typescript
// Example: Mocking external API
vi.mock('./externalApi', () => ({
  fetchData: vi.fn()
}));

// But prefer fakes for internal dependencies
const fakeRepo = new FakeUserRepository();
```
